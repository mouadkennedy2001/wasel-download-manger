const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WaselError, describeError, isTransient } = require('./engine/errors');
const { CookieJar, HttpClient } = require('./engine/http');
const { Throttle } = require('./engine/throttle');
const { applySettings, restoreSettings } = require('./engine/settings');
const { pageTitle, sniffPage } = require('./engine/sniff');
const { bestVariant, decryptSegment, isHlsMime, isHlsUrl, isPlaylist, mediaSegments } = require('./engine/hls');
const {
  CATEGORY_FOLDERS, categoryFor, cleanFileName, fileNameFromUrl, isAttachment, resolveFileName, uniqueName
} = require('./engine/filenames');

const MIN_SPLIT = 512 * 1024;
const TURBO_CONNECTIONS = 32;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const HLS_CONCURRENCY = 6;
const STEAL_SAFETY = 256 * 1024;
const MIN_INITIAL_CHUNK = 1024 * 1024;
const CHUNK_RETRIES = 3;
const PERSIST_INTERVAL = 4000;
const HASH_ALGORITHMS = ['sha256', 'sha1', 'md5', 'sha512'];
const ACTIVE_STATES = new Set(['downloading', 'queued']);

class DownloadManager {
  constructor({ dataFile, defaultFolder, onChange = () => {}, onEvent = () => {}, resolveProxy = async () => 'DIRECT' }) {
    this.dataFile = dataFile;
    this.defaultFolder = path.resolve(defaultFolder);
    this.outputFolder = this.defaultFolder;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.systemProxy = resolveProxy;
    this.proxyCache = new Map();
    this.items = [];
    this.active = new Map();
    this.settings = restoreSettings({});
    this.throttle = new Throttle(0);
    this.client = new HttpClient({
      userAgent: () => this.settings.userAgent,
      resolveProxy: (url) => this.proxyFor(url)
    });
    this.persistChain = Promise.resolve();
    this.lastPersist = 0;
    this.shuttingDown = false;
    this.hadActivity = false;
    this.tick = setInterval(() => this.reportProgress(), 500);
    this.tick.unref();
  }

  async initialize() {
    let stored = null;
    try {
      stored = JSON.parse(await fsp.readFile(this.dataFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.settings = restoreSettings(stored?.settings);
    this.applyRate();
    if (typeof stored?.settings?.outputFolder === 'string') {
      this.outputFolder = path.resolve(stored.settings.outputFolder);
    }
    try {
      await ensureDirectory(this.outputFolder);
    } catch {
      this.outputFolder = this.defaultFolder;
      await ensureDirectory(this.outputFolder);
    }

    const items = Array.isArray(stored?.items) ? stored.items : [];
    this.items = items.filter((item) => item && typeof item.url === 'string' && typeof item.savePath === 'string');
    for (const item of this.items) await this.restoreItem(item);
    await this.persist();
    this.publish();
  }

  // Brings rows written by older versions (and rows interrupted by a crash) into a
  // consistent, resumable shape.
  async restoreItem(item) {
    item.id ||= createId();
    item.fileName = cleanFileName(item.fileName || path.basename(item.savePath));
    if (!item.category || item.category === 'media') item.category = categoryFor(item.fileName);
    if (ACTIVE_STATES.has(item.status) || item.status === 'verifying') item.status = 'paused';
    if (typeof item.error === 'string') item.error = { code: 'unknown', params: { detail: item.error } };
    item.speed = 0;
    item.retry = null;
    item.request ||= {};
    await removeLegacySegments(item.savePath);
    if (item.status === 'paused' || item.status === 'error') {
      const partSize = await getFileSize(`${item.savePath}.part`);
      if (Array.isArray(item.chunks) && item.chunks.length && partSize === item.totalBytes) {
        item.chunks = item.chunks.map(({ start, end, done }) => ({ start, end, done: Math.min(done, end - start + 1) }));
        item.receivedBytes = item.chunks.reduce((sum, chunk) => sum + chunk.done, 0);
      } else {
        item.chunks = null;
        item.receivedBytes = partSize;
      }
    }
  }

  getState() {
    const downloads = this.items.map(publicItem);
    const speed = downloads.reduce((sum, item) => sum + (item.status === 'downloading' ? item.speed || 0 : 0), 0);
    return {
      downloads,
      settings: { ...this.settings, outputFolder: this.outputFolder },
      maxActiveDownloads: this.settings.maxActiveDownloads,
      stats: {
        speed,
        active: downloads.filter((item) => item.status === 'downloading').length,
        queued: downloads.filter((item) => item.status === 'queued').length,
        completed: downloads.filter((item) => item.status === 'completed').length,
        failed: downloads.filter((item) => item.status === 'error').length
      }
    };
  }

  // Export format: everything needed to recreate the list, never cookies.
  exportState() {
    return {
      app: 'wasel',
      version: 2,
      exportedAt: new Date().toISOString(),
      downloads: this.items.map((item) => ({
        url: item.url,
        fileName: item.fileName,
        status: item.status,
        totalBytes: item.totalBytes,
        createdAt: item.createdAt,
        referer: item.request?.referer || ''
      }))
    };
  }

  getDownload(id) {
    return this.items.find((item) => item.id === id);
  }

  async add(input = {}) {
    const {
      url, fileName, folder, startImmediately = true, referer, cookies, cookieHeader, userAgent,
      connections, checksum, source = 'manual', totalBytes, mime
    } = input;
    const parsed = parseHttpUrl(url);
    const nameLocked = typeof fileName === 'string' && Boolean(fileName.trim());
    const hls = isHlsUrl(parsed.href) || isHlsMime(mime);
    let suggestedName = cleanFileName(nameLocked ? fileName : fileNameFromUrl(parsed.href) || 'download');
    if (hls) suggestedName = suggestedName.replace(/\.m3u8$/i, '') + (/\.ts$/i.test(suggestedName) ? '' : '.ts');
    const category = categoryFor(suggestedName);
    const targetFolder = folder ? path.resolve(folder) : this.folderFor(category);
    await ensureDirectory(targetFolder);
    const unique = await this.reserveName(targetFolder, suggestedName);

    const item = {
      id: createId(),
      url: parsed.href,
      finalUrl: null,
      kind: hls ? 'hls' : 'file',
      fileName: unique,
      savePath: path.join(targetFolder, unique),
      folderLocked: Boolean(folder),
      nameLocked,
      nameResolved: false,
      status: startImmediately ? 'queued' : 'paused',
      category,
      receivedBytes: 0,
      totalBytes: Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : 0,
      speed: 0,
      resumable: null,
      mime: typeof mime === 'string' ? mime.slice(0, 120) : '',
      connections: Number.isInteger(connections) && connections >= 1 && connections <= 32 ? connections : null,
      checksum: normalizeChecksum(checksum),
      source: ['manual', 'browser', 'clipboard', 'import', 'protocol', 'batch'].includes(source) ? source : 'manual',
      request: {
        referer: typeof referer === 'string' ? referer.slice(0, 4096) : '',
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : '',
        cookieHeader: typeof cookieHeader === 'string' ? cookieHeader.slice(0, 16384) : '',
        cookies: Array.isArray(cookies) ? cookies.slice(0, 300) : []
      },
      chunks: null,
      validators: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      retry: null
    };
    this.items.unshift(item);
    await this.persist();
    this.publish();
    this.schedule();
    return publicItem(item);
  }

  // Turbo lifts the speed limit and uses the maximum number of connections per file.
  applyRate() {
    this.throttle.setRate(this.settings.turbo ? 0 : this.settings.speedLimit);
  }

  connectionsFor(item) {
    return item.connections || (this.settings.turbo ? TURBO_CONNECTIONS : this.settings.connectionsPerDownload);
  }

  folderFor(category) {
    return this.settings.categoryFolders
      ? path.join(this.outputFolder, CATEGORY_FOLDERS[category] || CATEGORY_FOLDERS.other)
      : this.outputFolder;
  }

  async reserveName(folder, name, ignoreId = null) {
    const reserved = new Set(this.items
      .filter((item) => item.id !== ignoreId && path.dirname(item.savePath).toLowerCase() === folder.toLowerCase())
      .map((item) => item.fileName.toLowerCase()));
    let candidate = uniqueName(name, reserved);
    const extension = path.extname(name);
    const base = name.slice(0, name.length - extension.length);
    let suffix = 1;
    while (reserved.has(candidate.toLowerCase())
      || await fileExists(path.join(folder, candidate))
      || await fileExists(path.join(folder, `${candidate}.part`))) {
      candidate = `${base} (${suffix})${extension}`;
      suffix += 1;
    }
    return candidate;
  }

  async probe({ url, referer, cookies, cookieHeader } = {}) {
    const parsed = parseHttpUrl(url);
    const jar = new CookieJar(Array.isArray(cookies) ? cookies : []);
    if (cookieHeader) jar.addHeader(cookieHeader, parsed.href);
    const control = { requests: new Set() };
    const timer = setTimeout(() => {
      control.stopReason = 'timeout';
      destroyRequests(control);
    }, 15_000);
    try {
      const { response, finalUrl } = await this.client.open(parsed.href, {
        headers: { Range: 'bytes=0-0' }, jar, referer, control
      });
      response.resume();
      destroyRequests(control);
      const status = response.statusCode;
      if (status >= 400) throw new WaselError('http', { status });
      const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const base = { url: parsed.href, finalUrl, duplicate: this.items.some((item) => item.url === parsed.href) };
      if (isHlsUrl(finalUrl) || isHlsMime(mime)) {
        const name = fileNameFromUrl(finalUrl).replace(/\.m3u8$/i, '') || 'stream';
        return { ...base, stream: true, fileName: `${cleanFileName(name)}.ts`, totalBytes: 0, resumable: true, mime, category: 'video' };
      }
      if (mime === 'text/html' && !isAttachment(response.headers['content-disposition'])) {
        // A web page rather than a file: look inside it for videos, audio and file links.
        const page = await this.readText(parsed.href, { jar, referer, control });
        return {
          ...base,
          page: true,
          title: pageTitle(page.text),
          candidates: sniffPage(page.text, page.finalUrl),
          fileName: resolveFileName({ finalUrl, originalUrl: parsed.href, mime }),
          totalBytes: 0,
          resumable: false,
          mime,
          category: 'other'
        };
      }
      const rangeTotal = Number(response.headers['content-range']?.match(/\/(\d+)$/)?.[1]);
      const length = Number(response.headers['content-length']);
      const fileName = resolveFileName({
        disposition: response.headers['content-disposition'],
        finalUrl,
        originalUrl: parsed.href,
        mime: response.headers['content-type']
      });
      return {
        url: parsed.href,
        finalUrl,
        fileName,
        totalBytes: status === 206 && Number.isSafeInteger(rangeTotal)
          ? rangeTotal
          : (status === 200 && Number.isSafeInteger(length) ? length : 0),
        resumable: status === 206,
        mime: String(response.headers['content-type'] || '').split(';')[0],
        category: categoryFor(fileName),
        duplicate: this.items.some((item) => item.url === parsed.href)
      };
    } catch (error) {
      if (control.stopReason === 'timeout') throw new WaselError('timeout', {});
      if (error instanceof WaselError) throw error;
      const described = describeError(error, { host: parsed.host });
      throw new WaselError(described.code, described.params);
    } finally {
      clearTimeout(timer);
    }
  }

  // Reads a small text body (web page or playlist), capped so huge pages cannot stall us.
  async readText(url, { jar, referer, control, headers = {}, limit = MAX_PAGE_BYTES }) {
    const { response, finalUrl } = await this.client.open(url, { headers, jar, referer, control });
    if (response.statusCode >= 400) {
      response.resume();
      throw new WaselError('http', { status: response.statusCode });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) break;
    }
    if (!response.destroyed) response.destroy();
    return { text: Buffer.concat(chunks).toString('utf8'), finalUrl, mime: String(response.headers['content-type'] || '') };
  }

  async readBuffer(url, { jar, referer, control }) {
    const { response } = await this.client.open(url, { jar, referer, control });
    if (response.statusCode >= 400) {
      response.resume();
      throw new WaselError('http', { status: response.statusCode });
    }
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async pause(id) {
    const item = this.requireItem(id);
    if (!ACTIVE_STATES.has(item.status)) return;
    item.status = 'paused';
    item.speed = 0;
    item.retry = null;
    await this.stopActive(id, 'paused');
    await this.persist();
    this.publish();
  }

  async resume(id) {
    const item = this.requireItem(id);
    if (!['paused', 'error', 'cancelled'].includes(item.status)) return;
    item.status = 'queued';
    item.error = null;
    await this.persist();
    this.publish();
    this.schedule();
  }

  async restart(id) {
    const item = this.requireItem(id);
    await this.stopActive(id, 'cancelled');
    await removePartial(item.savePath);
    if (item.status === 'completed' && await fileExists(item.savePath)) {
      const folder = path.dirname(item.savePath);
      item.fileName = await this.reserveName(folder, item.fileName, item.id);
      item.savePath = path.join(folder, item.fileName);
    }
    Object.assign(item, {
      status: 'queued', receivedBytes: 0, speed: 0, chunks: null, validators: null, error: null,
      retry: null, completedAt: null, nameResolved: item.nameLocked
    });
    if (item.checksum) item.checksum = { algorithm: item.checksum.algorithm, expected: item.checksum.expected };
    await this.persist();
    this.publish();
    this.schedule();
  }

  async cancel(id) {
    const item = this.requireItem(id);
    if (item.status === 'completed') return;
    item.status = 'cancelled';
    item.error = null;
    item.speed = 0;
    await this.stopActive(id, 'cancelled');
    await removePartial(item.savePath);
    item.receivedBytes = 0;
    item.chunks = null;
    await this.persist();
    this.publish();
  }

  async remove(id, { deleteFile = false } = {}) {
    const item = this.requireItem(id);
    await this.stopActive(id, 'removed');
    await removePartial(item.savePath);
    if (deleteFile && item.status === 'completed') {
      try {
        await fsp.unlink(item.savePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.items = this.items.filter((entry) => entry.id !== id);
    await this.persist();
    this.publish();
  }

  async clearCompleted() {
    this.items = this.items.filter((item) => item.status !== 'completed');
    await this.persist();
    this.publish();
  }

  async pauseAll() {
    await Promise.all(this.items.filter((item) => ACTIVE_STATES.has(item.status)).map((item) => this.pause(item.id)));
  }

  async resumeAll() {
    for (const item of this.items) {
      if (!['paused', 'error'].includes(item.status)) continue;
      item.status = 'queued';
      item.error = null;
    }
    await this.persist();
    this.publish();
    this.schedule();
  }

  async stopAll() {
    await this.pauseAll();
  }

  async setOutputFolder(folder) {
    if (typeof folder !== 'string' || !folder.trim()) throw new WaselError('invalid-folder', {});
    const resolvedFolder = path.resolve(folder);
    const info = await fsp.stat(resolvedFolder);
    if (!info.isDirectory()) throw new WaselError('not-directory', { path: resolvedFolder });
    this.outputFolder = resolvedFolder;
    await this.persist();
    this.publish();
    return this.getState().settings;
  }

  async updateSettings(changes) {
    this.settings = applySettings(this.settings, changes);
    this.applyRate();
    this.proxyCache.clear();
    await this.persist();
    this.publish();
    this.schedule();
    return this.getState().settings;
  }

  async hash(id, algorithm = 'sha256') {
    const item = this.requireItem(id);
    if (item.status !== 'completed') throw new WaselError('not-completed', {});
    if (!HASH_ALGORITHMS.includes(algorithm)) throw new WaselError('invalid-setting', { key: 'algorithm' });
    return hashFile(item.savePath, algorithm);
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.tick);
    const running = [...this.active.keys()];
    for (const id of running) {
      const item = this.getDownload(id);
      if (item && item.status === 'downloading') item.status = 'paused';
    }
    await Promise.all(running.map((id) => this.stopActive(id, 'shutdown')));
    await this.persist();
    this.client.destroy();
  }

  async stopActive(id, reason) {
    const control = this.active.get(id);
    if (!control) return;
    control.stopReason = reason;
    destroyRequests(control);
    clearTimeout(control.retryTimer);
    control.wake?.();
    await control.done;
  }

  requireItem(id) {
    const item = this.getDownload(id);
    if (!item) throw new WaselError('not-found', {});
    return item;
  }

  async proxyFor(rawUrl) {
    const { mode, url } = this.settings.proxy;
    if (mode === 'none') return null;
    if (mode === 'manual') return /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`;
    const origin = new URL(rawUrl).origin;
    const cached = this.proxyCache.get(origin);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    let value = null;
    try {
      const rule = String(await this.systemProxy(rawUrl) || 'DIRECT');
      const entry = rule.split(';').map((part) => part.trim()).find((part) => /^(PROXY|HTTPS)\s+/i.test(part));
      if (entry) {
        const [kind, address] = entry.split(/\s+/);
        value = `${kind.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${address}`;
      }
    } catch {
      value = null;
    }
    this.proxyCache.set(origin, { value, at: Date.now() });
    return value;
  }

  // New rows are unshifted, so the oldest queued row (the end of the list) starts first.
  schedule() {
    if (this.shuttingDown) return;
    while (this.active.size < this.settings.maxActiveDownloads) {
      const item = this.items.findLast((entry) => entry.status === 'queued' && !this.active.has(entry.id));
      if (!item) break;
      const now = Date.now();
      const control = { requests: new Set(), samples: [[now, item.receivedBytes]], stopReason: null };
      this.active.set(item.id, control);
      item.status = 'downloading';
      item.error = null;
      this.publish();
      control.done = this.runDownload(item, control)
        .catch((error) => {
          item.status = 'error';
          item.error = describeError(error, { path: item.savePath });
        })
        .finally(async () => {
          this.active.delete(item.id);
          item.speed = 0;
          try {
            await this.persist();
          } catch (error) {
            item.status = 'error';
            item.error = describeError(error, { path: this.dataFile });
          }
          this.publish();
          this.schedule();
          this.checkIdle();
        });
    }
  }

  checkIdle() {
    if (this.shuttingDown || this.active.size) return;
    if (this.items.some((item) => ACTIVE_STATES.has(item.status))) return;
    if (this.hadActivity) {
      this.hadActivity = false;
      this.onEvent({ type: 'idle' });
    }
  }

  async runDownload(item, control) {
    const jar = new CookieJar(item.request?.cookies || []);
    if (item.request?.cookieHeader) jar.addHeader(item.request.cookieHeader, item.url);
    control.jar = jar;
    this.hadActivity = true;
    let attempt = 0;
    let restarts = 0;
    let lastFailureBytes = -1;
    for (;;) {
      try {
        await this.transfer(item, control);
        if (control.stopReason) return;
        await this.finalize(item);
        return;
      } catch (error) {
        if (control.stopReason || this.shuttingDown) return;
        if (error.code === 'ERR_RESTART' && restarts < 2) {
          restarts += 1;
          await this.resetProgress(item);
          continue;
        }
        if (item.receivedBytes > lastFailureBytes) attempt = 0;
        lastFailureBytes = item.receivedBytes;
        if (!isTransient(error) || attempt >= this.settings.retryCount) {
          item.status = 'error';
          item.error = describeError(error, { path: item.savePath, host: safeHost(item.url) });
          item.retry = null;
          item.speed = 0;
          this.onEvent({ type: 'failed', item: publicItem(item) });
          return;
        }
        attempt += 1;
        const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        item.retry = { attempt, max: this.settings.retryCount, at: Date.now() + delay, code: describeError(error).code };
        item.speed = 0;
        this.publish();
        await new Promise((resolve) => {
          control.wake = resolve;
          control.retryTimer = setTimeout(resolve, delay);
        });
        item.retry = null;
        if (control.stopReason) return;
      }
    }
  }

  async resetProgress(item) {
    await removePartial(item.savePath);
    item.chunks = null;
    item.validators = null;
    item.receivedBytes = 0;
  }

  // One attempt at moving bytes: resumes a chunk map when one exists, otherwise opens
  // a single request that doubles as the range-support probe.
  async transfer(item, control) {
    await ensureDirectory(path.dirname(item.savePath));
    if (item.kind === 'hls') {
      await this.transferHls(item, control);
      return;
    }
    const partPath = `${item.savePath}.part`;
    if (item.chunks?.length && item.totalBytes > 0 && await getFileSize(partPath) === item.totalBytes) {
      await this.transferChunks(item, control, null);
      return;
    }

    item.chunks = null;
    const offset = await getFileSize(partPath);
    const { response, finalUrl } = await this.request(item, control, { Range: `bytes=${offset}-` }, item.url);
    item.finalUrl = finalUrl;
    control.resolvedUrl = finalUrl;
    const status = response.statusCode;

    if (status === 416 && offset > 0) {
      response.resume();
      const total = Number(response.headers['content-range']?.match(/\/(\d+)$/)?.[1]);
      if (total === offset) {
        item.totalBytes = total;
        item.receivedBytes = total;
        return;
      }
      throw Object.assign(new Error('Partial file no longer matches the server'), { code: 'ERR_RESTART' });
    }
    if (status !== 200 && status !== 206) {
      response.resume();
      throw new WaselError('http', { status });
    }

    const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (isHlsMime(mime) || isHlsUrl(finalUrl)) {
      response.resume();
      item.kind = 'hls';
      await this.transferHls(item, control);
      return;
    }
    if (offset === 0 && await this.resolvePageLink(item, response, mime, finalUrl, control)) {
      throw Object.assign(new Error('Switched from a page to its media'), { code: 'ERR_RESTART' });
    }
    if (offset === 0) await this.adoptResponseName(item, response, finalUrl);
    const range = response.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (status === 206 && range && Number(range[1]) === offset) {
      const total = Number(range[3]);
      item.totalBytes = total;
      item.resumable = true;
      item.validators = {
        etag: response.headers.etag && !response.headers.etag.startsWith('W/') ? response.headers.etag : null,
        lastModified: response.headers['last-modified'] || null
      };
      await preallocate(`${item.savePath}.part`, total, offset > 0);
      item.chunks = planChunks(total, offset, this.connectionsFor(item));
      item.receivedBytes = offset;
      await this.transferChunks(item, control, response);
      return;
    }
    if (status === 206) {
      response.resume();
      throw new WaselError('bad-range', {});
    }

    // No range support: stream the whole body sequentially.
    item.resumable = false;
    const length = Number(response.headers['content-length']);
    item.totalBytes = Number.isSafeInteger(length) ? length : 0;
    item.receivedBytes = 0;
    const handle = await fsp.open(`${item.savePath}.part`, 'w');
    try {
      for await (const buffer of response) {
        if (control.stopReason) break;
        await this.throttle.consume(buffer.length, () => control.stopReason);
        await handle.write(buffer, 0, buffer.length, null);
        item.receivedBytes += buffer.length;
      }
    } finally {
      await handle.close();
    }
    if (control.stopReason) return;
    if (item.totalBytes > 0 && item.receivedBytes !== item.totalBytes) {
      throw Object.assign(new Error('Connection closed early'), { code: 'ERR_INCOMPLETE' });
    }
  }

  // "Any link": when a link opens a web page instead of a file, download the main video,
  // stream or audio found on that page. Returns true when the item now points elsewhere.
  async resolvePageLink(item, response, mime, finalUrl, control) {
    if (mime !== 'text/html' || item.pageResolved || isAttachment(response.headers['content-disposition'])) return false;
    if (/\.html?$/i.test(item.fileName) || categoryFor(fileNameFromUrl(item.url)) !== 'other') return false;
    item.pageResolved = true;
    response.resume();
    const page = await this.readText(finalUrl, { jar: control.jar, referer: item.request?.referer, control });
    const media = sniffPage(page.text, page.finalUrl).find((candidate) => ['stream', 'video', 'audio'].includes(candidate.kind));
    if (!media) return true;
    item.pageUrl = item.url;
    item.request = { ...item.request, referer: item.request?.referer || item.url };
    item.url = media.url;
    item.kind = media.kind === 'stream' ? 'hls' : 'file';
    if (!item.nameLocked) {
      const title = pageTitle(page.text).replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '') || media.name;
      const extension = media.kind === 'stream' ? '.ts' : path.extname(media.name) || '.mp4';
      const folder = path.dirname(item.savePath);
      item.fileName = await this.reserveName(folder, cleanFileName(`${title.replace(/\.[a-z0-9]{2,4}$/i, '')}${extension}`), item.id);
      item.savePath = path.join(folder, item.fileName);
      item.category = categoryFor(item.fileName);
      item.nameResolved = true;
    }
    control.resolvedUrl = null;
    this.publish();
    return true;
  }

  // Downloads an HLS stream: best variant, segments fetched in parallel but written in
  // order, AES-128 decrypted, resumable from the last written segment.
  async transferHls(item, control) {
    const options = { jar: control.jar, referer: item.request?.referer, control };
    if (!/\.ts$/i.test(item.fileName) && !item.nameLocked) {
      const folder = path.dirname(item.savePath);
      item.fileName = await this.reserveName(folder, `${item.fileName.replace(/\.[^.]+$/, '') || 'stream'}.ts`, item.id);
      item.savePath = path.join(folder, item.fileName);
      item.category = 'video';
    }
    let playlist = await this.readText(item.url, options);
    if (!isPlaylist(playlist.text)) throw new WaselError('not-playlist', {});
    const variant = bestVariant(playlist.text, playlist.finalUrl);
    if (variant) playlist = await this.readText(variant.url, options);
    const segments = mediaSegments(playlist.text, playlist.finalUrl);
    if (!segments.length) throw new WaselError('not-playlist', {});

    const partPath = `${item.savePath}.part`;
    const state = item.hls?.count === segments.length ? item.hls : { next: 0, bytes: 0, count: segments.length };
    if (await getFileSize(partPath) < state.bytes) Object.assign(state, { next: 0, bytes: 0 });
    item.hls = state;
    item.resumable = true;
    item.chunks = null;
    const handle = await fsp.open(partPath, state.bytes ? 'r+' : 'w');
    await handle.truncate(state.bytes);
    const keys = new Map();
    const fetchSegment = async (segment) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          let data = await this.readBuffer(segment.url, options);
          if (segment.key) {
            if (!keys.has(segment.key.uri)) keys.set(segment.key.uri, this.readBuffer(segment.key.uri, options));
            data = decryptSegment(data, await keys.get(segment.key.uri), segment);
          }
          return data;
        } catch (error) {
          if (control.stopReason || attempt >= 4 || !isTransient(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    };
    const pending = new Map();
    try {
      let launched = state.next;
      const concurrency = Math.min(HLS_CONCURRENCY, this.connectionsFor(item));
      while (state.next < segments.length && !control.stopReason) {
        while (launched < segments.length && pending.size < concurrency) {
          const request = fetchSegment(segments[launched]);
          request.catch(() => {});
          pending.set(launched, request);
          launched += 1;
        }
        const data = await pending.get(state.next);
        pending.delete(state.next);
        if (control.stopReason) break;
        await this.throttle.consume(data.length, () => control.stopReason);
        await handle.write(data, 0, data.length, state.bytes);
        state.bytes += data.length;
        state.next += 1;
        item.receivedBytes = state.bytes;
        item.totalBytes = Math.round((state.bytes / state.next) * segments.length);
      }
    } finally {
      await handle.close();
    }
    if (control.stopReason) return;
    item.totalBytes = state.bytes;
  }

  request(item, control, headers, url = control.resolvedUrl || item.url) {
    return this.client.open(url, {
      headers: item.request?.userAgent ? { ...headers, 'User-Agent': item.request.userAgent } : headers,
      jar: control.jar,
      referer: item.request?.referer,
      control
    });
  }

  // Applies the server-provided name (Content-Disposition, redirect target, MIME) before
  // any byte is written, and refuses HTML error pages that stand in for a file.
  async adoptResponseName(item, response, finalUrl) {
    const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    item.mime = mime || item.mime;
    const expectedCategory = categoryFor(fileNameFromUrl(item.url));
    if (mime === 'text/html' && !isAttachment(response.headers['content-disposition'])
      && expectedCategory !== 'other' && !/\.html?$/i.test(item.fileName)) {
      response.resume();
      throw new WaselError('html-response', { host: safeHost(finalUrl) });
    }
    if (item.nameLocked || item.nameResolved) return;
    item.nameResolved = true;
    const name = resolveFileName({
      disposition: response.headers['content-disposition'],
      finalUrl,
      originalUrl: item.url,
      mime
    });
    const category = categoryFor(name);
    const folder = item.folderLocked ? path.dirname(item.savePath) : this.folderFor(category);
    if (name === item.fileName && folder === path.dirname(item.savePath)) return;
    await ensureDirectory(folder);
    await removePartial(item.savePath);
    item.fileName = await this.reserveName(folder, name, item.id);
    item.savePath = path.join(folder, item.fileName);
    item.category = category;
    this.publish();
  }

  async transferChunks(item, control, firstResponse) {
    const handle = await fsp.open(`${item.savePath}.part`, 'r+');
    const connections = this.connectionsFor(item);
    item.receivedBytes = item.chunks.reduce((sum, chunk) => sum + chunk.done, 0);
    control.failure = null;
    let liveWorkers = 0;

    const takeChunk = () => {
      const pending = item.chunks.find((chunk) => !chunk.active && chunk.done < chunk.end - chunk.start + 1);
      return pending || this.steal(item);
    };

    const worker = async (initial) => {
      liveWorkers += 1;
      let response = initial?.response || null;
      let chunk = initial?.chunk || null;
      try {
        while (!control.stopReason && !control.failure) {
          chunk ||= takeChunk();
          if (!chunk) return;
          chunk.active = true;
          let failures = 0;
          try {
            for (;;) {
              try {
                await this.fetchChunk(item, control, handle, chunk, response);
                response = null;
                break;
              } catch (error) {
                if (response && !response.destroyed) response.destroy();
                response = null;
                if (control.stopReason || control.failure) return;
                // Servers that cap connections per client answer extra ranges with
                // 403/429/503. Retire this worker and let the others take its range.
                if (error.code === 'http' && [403, 429, 503].includes(error.params.status) && liveWorkers > 1) return;
                failures += 1;
                if (!isTransient(error) || failures > CHUNK_RETRIES) throw error;
                await new Promise((resolve) => setTimeout(resolve, 400 * failures));
              }
            }
          } finally {
            chunk.active = false;
            chunk.inflight = 0;
          }
          chunk = null;
        }
      } catch (error) {
        control.failure ||= error;
        destroyRequests(control);
      } finally {
        liveWorkers -= 1;
      }
    };

    try {
      const workers = [];
      if (firstResponse) workers.push(worker({ response: firstResponse, chunk: item.chunks[0] }));
      while (workers.length < connections) workers.push(worker(null));
      await Promise.all(workers);
      // A retired worker may leave a range behind once every peer has finished.
      while (!control.stopReason && !control.failure && item.chunks.some(isIncomplete)) await worker(null);
    } finally {
      await handle.close();
    }
    if (control.stopReason) return;
    if (control.failure) throw control.failure;
    if (item.chunks.some(isIncomplete)) {
      throw Object.assign(new Error('Some ranges are incomplete'), { code: 'ERR_INCOMPLETE' });
    }
  }

  async fetchChunk(item, control, handle, chunk, response) {
    if (!response) {
      const start = chunk.start + chunk.done;
      const opened = await this.request(item, control, {
        Range: `bytes=${start}-${chunk.end}`,
        ...rangeValidatorHeaders(item.validators)
      });
      response = opened.response;
      const range = response.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (response.statusCode === 200) {
        response.resume();
        throw Object.assign(new Error('Server ignored the range or the file changed'), { code: 'ERR_RESTART' });
      }
      if ([403, 404, 410].includes(response.statusCode) && control.resolvedUrl !== item.url) {
        // Signed redirect targets expire; go back through the original link next time.
        response.resume();
        control.resolvedUrl = item.url;
        throw Object.assign(new Error('Redirect target expired'), { code: 'ERR_INCOMPLETE' });
      }
      if (response.statusCode !== 206) {
        response.resume();
        throw new WaselError('http', { status: response.statusCode });
      }
      if (!range || Number(range[1]) !== start || Number(range[3]) !== item.totalBytes) {
        response.resume();
        throw Object.assign(new Error('Unexpected range'), { code: 'ERR_RESTART' });
      }
    }

    for await (const buffer of response) {
      if (control.stopReason || control.failure) break;
      await this.throttle.consume(buffer.length, () => control.stopReason);
      const position = chunk.start + chunk.done;
      const remaining = chunk.end - position + 1;
      if (remaining <= 0) break;
      const data = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunk.inflight = data.length;
      await handle.write(data, 0, data.length, position);
      chunk.inflight = 0;
      chunk.done += data.length;
      item.receivedBytes += data.length;
      if (chunk.start + chunk.done > chunk.end) break;
    }
    if (!response.destroyed) response.destroy();
    if (control.stopReason || control.failure) return;
    if (isIncomplete(chunk)) throw Object.assign(new Error('Range ended early'), { code: 'ERR_INCOMPLETE' });
  }

  // Dynamic segmentation: an idle connection splits the largest active range in half,
  // so all connections stay busy until the very last byte.
  steal(item) {
    let best = null;
    let bestRemaining = 0;
    for (const chunk of item.chunks) {
      if (!chunk.active) continue;
      const remaining = chunk.end - (chunk.start + chunk.done + (chunk.inflight || 0)) + 1 - STEAL_SAFETY;
      if (remaining > bestRemaining) {
        best = chunk;
        bestRemaining = remaining;
      }
    }
    if (!best || bestRemaining < MIN_SPLIT * 2) return null;
    const split = best.start + best.done + (best.inflight || 0) + STEAL_SAFETY + Math.floor(bestRemaining / 2);
    const created = { start: split, end: best.end, done: 0 };
    best.end = split - 1;
    item.chunks.splice(item.chunks.indexOf(best) + 1, 0, created);
    return created;
  }

  async finalize(item) {
    const partPath = `${item.savePath}.part`;
    const size = await getFileSize(partPath);
    if (item.totalBytes > 0 && size !== item.totalBytes) {
      throw Object.assign(new Error('File size mismatch'), { code: 'ERR_INCOMPLETE' });
    }
    if (await fileExists(item.savePath)) {
      const folder = path.dirname(item.savePath);
      const fresh = await this.reserveName(folder, item.fileName, item.id);
      await fsp.rename(partPath, path.join(folder, `${fresh}.part`));
      item.fileName = fresh;
      item.savePath = path.join(folder, fresh);
    }
    await fsp.rename(`${item.savePath}.part`, item.savePath);
    item.receivedBytes = size;
    item.totalBytes = size;
    item.chunks = null;
    item.hls = null;
    item.speed = 0;
    item.error = null;
    item.retry = null;
    if (item.checksum?.expected) {
      item.status = 'verifying';
      this.publish();
      const actual = await hashFile(item.savePath, item.checksum.algorithm);
      item.checksum = { ...item.checksum, actual, ok: actual.toLowerCase() === item.checksum.expected.toLowerCase() };
    }
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    this.onEvent({ type: 'completed', item: publicItem(item) });
  }

  reportProgress() {
    let changed = false;
    const now = Date.now();
    for (const [id, control] of this.active) {
      const item = this.getDownload(id);
      if (!item || item.status !== 'downloading') continue;
      control.samples.push([now, item.receivedBytes]);
      while (control.samples.length > 1 && now - control.samples[0][0] > 3000) control.samples.shift();
      const [sampleTime, sampleBytes] = control.samples[0];
      const elapsed = now - sampleTime;
      item.speed = elapsed >= 400 ? Math.max(0, Math.round(((item.receivedBytes - sampleBytes) * 1000) / elapsed)) : 0;
      changed = true;
    }
    if (changed) {
      this.publish();
      if (now - this.lastPersist > PERSIST_INTERVAL) this.persist().catch(() => {});
    }
  }

  publish() {
    this.onChange(this.getState());
  }

  persist() {
    this.lastPersist = Date.now();
    const contents = JSON.stringify({
      version: 2,
      items: this.items.map(storedItem),
      settings: { ...this.settings, outputFolder: this.outputFolder }
    });
    this.persistChain = this.persistChain.catch(() => {}).then(() => writeAtomic(this.dataFile, contents));
    return this.persistChain;
  }
}

function isIncomplete(chunk) {
  return chunk.done < chunk.end - chunk.start + 1;
}

// Splits the remaining bytes evenly across connections; the first range keeps any bytes
// already on disk from an interrupted single-connection download.
function planChunks(total, offset, connections) {
  const remaining = total - offset;
  const count = Math.max(1, Math.min(connections, Math.floor(remaining / MIN_INITIAL_CHUNK) || 1));
  const size = Math.ceil(remaining / count);
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = index === 0 ? 0 : offset + index * size;
    const end = Math.min(total - 1, offset + (index + 1) * size - 1);
    if (end < start) break;
    chunks.push({ start, end, done: index === 0 ? offset : 0 });
  }
  return chunks;
}

function publicItem(item) {
  const { request, chunks, validators, ...rest } = item;
  return {
    ...rest,
    referer: request?.referer || '',
    hasCookies: Boolean(request?.cookies?.length || request?.cookieHeader),
    segments: chunks ? chunks.map((chunk) => [chunk.start, chunk.end, chunk.done, chunk.active ? 1 : 0]) : null
  };
}

function storedItem(item) {
  return {
    ...item,
    speed: 0,
    retry: null,
    chunks: item.chunks ? item.chunks.map(({ start, end, done }) => ({ start, end, done })) : null
  };
}

function parseHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new WaselError('empty-url', {});
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new WaselError('invalid-url', { url: value.slice(0, 200) });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new WaselError('unsupported-protocol', { protocol: parsed.protocol });
  return parsed;
}

function normalizeChecksum(checksum) {
  if (!checksum || typeof checksum.expected !== 'string' || !checksum.expected.trim()) return null;
  const expected = checksum.expected.trim().toLowerCase();
  const algorithm = HASH_ALGORITHMS.includes(checksum.algorithm) ? checksum.algorithm : guessAlgorithm(expected);
  if (!algorithm || !/^[0-9a-f]+$/.test(expected)) throw new WaselError('invalid-checksum', {});
  return { algorithm, expected };
}

function guessAlgorithm(hex) {
  return { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' }[hex.length] || null;
}

function rangeValidatorHeaders(validators) {
  if (validators?.etag) return { 'If-Range': validators.etag };
  if (validators?.lastModified) return { 'If-Range': validators.lastModified };
  return {};
}

function createId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

async function ensureDirectory(folder) {
  const resolvedFolder = path.resolve(folder);
  try {
    const info = await fsp.stat(resolvedFolder);
    if (!info.isDirectory()) throw new WaselError('not-directory', { path: resolvedFolder });
  } catch (error) {
    if (error instanceof WaselError) throw error;
    if (error.code === 'ENOTDIR') throw new WaselError('not-directory', { path: resolvedFolder });
    if (error.code !== 'ENOENT') throw error;
    if (path.normalize(resolvedFolder) === path.normalize(path.parse(resolvedFolder).root)) {
      throw new WaselError('drive-unavailable', { path: resolvedFolder });
    }
    await fsp.mkdir(resolvedFolder, { recursive: true });
  }
}

async function preallocate(file, size, keepExisting) {
  const handle = await fsp.open(file, keepExisting ? 'r+' : 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, contents, 'utf8');
  try {
    await fsp.rename(temporary, file);
  } catch {
    await fsp.writeFile(file, contents, 'utf8');
    await fsp.rm(temporary, { force: true });
  }
}

function destroyRequests(control) {
  for (const request of control.requests || []) request.destroy();
}

async function getFileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 0;
    throw error;
  }
}

async function removePartial(savePath) {
  await fsp.rm(`${savePath}.part`, { force: true });
  await removeLegacySegments(savePath);
}

// Version 1 stored parallel ranges as "<name>.part.segment-N" files.
async function removeLegacySegments(savePath) {
  const directory = path.dirname(savePath);
  const prefix = `${path.basename(savePath)}.part.segment-`;
  let files;
  try {
    files = await fsp.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(files.filter((file) => file.startsWith(prefix))
    .map((file) => fsp.rm(path.join(directory, file), { force: true })));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('data', (data) => hash.update(data))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { DownloadManager, categoryFor, cleanFileName, uniqueName, planChunks };
