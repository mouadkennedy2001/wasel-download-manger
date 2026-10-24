const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { DownloadManager, planChunks } = require('../src/download-manager');
const { categoryFor, cleanFileName, parseContentDisposition, resolveFileName, uniqueName } = require('../src/engine/filenames');
const { CookieJar } = require('../src/engine/http');
const { applySettings, restoreSettings } = require('../src/engine/settings');
const { Throttle } = require('../src/engine/throttle');

const BIG = Buffer.alloc(6 * 1024 * 1024 + 137);
for (let index = 0; index < BIG.length; index += 1) BIG[index] = (index * 31 + 7) % 251;
const SLOW = Buffer.alloc(512 * 1024, 0x5a);

let tempDirectory;
let server;
let base;
const log = { ranges: [], userAgents: [], maxConcurrent: 0, active: 0, flakyHits: 0, limitedActive: 0 };

function sendRange(request, response, content, { etag, delay = 0, chunkDelay = 0, chunkSize = 64 * 1024 } = {}) {
  const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  let start = 0;
  let end = content.length - 1;
  let status = 200;
  if (match) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    if (start >= content.length) {
      response.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
      response.end();
      return;
    }
    status = 206;
    log.ranges.push([start, end]);
  }
  const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
  if (etag) headers.ETag = etag;
  log.active += 1;
  log.maxConcurrent = Math.max(log.maxConcurrent, log.active);
  let cursor = start;
  let timer;
  response.once('close', () => {
    clearTimeout(timer);
    log.active -= 1;
  });
  const writeNext = () => {
    if (response.destroyed) return;
    const next = Math.min(cursor + chunkSize, end + 1);
    response.write(content.subarray(cursor, next));
    cursor = next;
    if (cursor > end) response.end();
    else timer = setTimeout(writeNext, chunkDelay);
  };
  timer = setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(status, headers);
    writeNext();
  }, delay);
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wasel-engine-'));
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    log.userAgents.push(request.headers['user-agent'] || '');
    switch (url.pathname) {
      case '/payload.txt':
        sendRange(request, response, Buffer.from('wasel download test payload'));
        return;
      case '/slow.bin':
        sendRange(request, response, SLOW, { chunkSize: 8 * 1024, chunkDelay: 5 });
        return;
      case '/big.bin':
        sendRange(request, response, BIG, { etag: '"big-v1"', delay: 20, chunkDelay: 3 });
        return;
      case '/needs-browser-ua.zip':
        if (!/Mozilla\/5\.0/.test(request.headers['user-agent'] || '')) {
          response.writeHead(403);
          response.end('Forbidden');
          return;
        }
        sendRange(request, response, Buffer.from('browser-only payload'));
        return;
      case '/members/file.zip':
        if (!/(^|; )session=abc123(;|$)/.test(request.headers.cookie || '') || request.headers.referer !== 'https://site.example/page') {
          response.writeHead(403);
          response.end();
          return;
        }
        sendRange(request, response, Buffer.from('members payload'));
        return;
      case '/login-redirect':
        response.writeHead(302, { Location: '/needs-redirect-cookie.bin', 'Set-Cookie': 'token=xyz; Path=/' });
        response.end();
        return;
      case '/needs-redirect-cookie.bin':
        if (!/token=xyz/.test(request.headers.cookie || '')) {
          response.writeHead(401);
          response.end();
          return;
        }
        sendRange(request, response, Buffer.from('redirect cookie payload'));
        return;
      case '/download.php':
        response.setHeader('Content-Disposition', "attachment; filename=\"fallback.zip\"; filename*=UTF-8''%D9%85%D9%84%D9%81%20%D8%B9%D8%B1%D8%A8%D9%8A.zip");
        sendRange(request, response, Buffer.from('arabic name payload'));
        return;
      case '/flaky.bin': {
        log.flakyHits += 1;
        if (log.flakyHits === 1) {
          response.writeHead(200, { 'Content-Length': SLOW.length, 'Accept-Ranges': 'bytes' });
          response.write(SLOW.subarray(0, 100 * 1024), () => setTimeout(() => response.socket.destroy(), 20));
          return;
        }
        sendRange(request, response, SLOW);
        return;
      }
      case '/expired.zip':
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<html><body>Please sign in</body></html>');
        return;
      case '/no-range.bin':
        response.writeHead(200, { 'Content-Length': SLOW.length });
        response.end(SLOW);
        return;
      case '/limited.bin': {
        if (request.headers.range && log.limitedActive >= 2) {
          response.writeHead(503);
          response.end();
          return;
        }
        log.limitedActive += 1;
        response.once('close', () => { log.limitedActive -= 1; });
        sendRange(request, response, BIG, { chunkDelay: 1 });
        return;
      }
      case '/missing.zip':
        response.writeHead(404);
        response.end();
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

async function createManager(name, settings = {}) {
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, `${name}.json`),
    defaultFolder: path.join(tempDirectory, name)
  });
  await manager.initialize();
  await manager.updateSettings({ retryCount: 3, ...settings });
  return manager;
}

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const finished = (manager, id) => () => ['completed', 'error'].includes(manager.getDownload(id)?.status);

test('sanitizes names, assigns categories and decodes Content-Disposition (including UTF-8 Arabic)', () => {
  assert.equal(cleanFileName('../bad:name?.zip'), 'bad_name_.zip');
  assert.equal(cleanFileName('CON.txt'), 'download');
  assert.equal(categoryFor('movie.mkv'), 'video');
  assert.equal(categoryFor('song.flac'), 'music');
  assert.equal(categoryFor('report.pdf'), 'documents');
  assert.equal(categoryFor('setup.msi'), 'software');
  assert.equal(uniqueName('file.zip', new Set(['file.zip'])), 'file (1).zip');
  assert.equal(parseContentDisposition("attachment; filename*=UTF-8''%D9%85%D9%84%D9%81.pdf"), 'ملف.pdf');
  assert.equal(parseContentDisposition('attachment; filename="report \\"Q1\\".xlsx"'), 'report "Q1".xlsx');
  const mojibake = Buffer.from('تقرير.pdf', 'utf8').toString('latin1');
  assert.equal(parseContentDisposition(`attachment; filename="${mojibake}"`), 'تقرير.pdf');
  assert.equal(resolveFileName({ finalUrl: 'https://cdn.example/get', mime: 'application/zip' }), 'get.zip');
});

test('plans evenly sized ranges and keeps bytes from an interrupted single stream', () => {
  const chunks = planChunks(10 * 1024 * 1024, 0, 4);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, 10 * 1024 * 1024 - 1);
  for (let index = 1; index < chunks.length; index += 1) assert.equal(chunks[index].start, chunks[index - 1].end + 1);
  const resumed = planChunks(4 * 1024 * 1024, 1000, 2);
  assert.equal(resumed[0].done, 1000);
  assert.equal(planChunks(500, 0, 8).length, 1, 'small files use one range');
});

test('cookie jar matches domains, paths and secure flags, and learns Set-Cookie', () => {
  const jar = new CookieJar([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'files.example.com', hostOnly: true, path: '/dl' },
    { name: 's', value: '3', domain: 'example.com', secure: true }
  ]);
  assert.equal(jar.headerFor('http://cdn.example.com/x'), 'a=1');
  assert.equal(jar.headerFor('https://files.example.com/dl/file.zip'), 'a=1; b=2; s=3');
  assert.equal(jar.headerFor('https://other.org/'), '');
  jar.setFromResponse(['c=4; Path=/; Domain=example.com'], 'https://www.example.com/login');
  assert.match(jar.headerFor('https://example.com/'), /c=4/);
});

test('validates settings strictly and restores old files leniently', () => {
  const defaults = restoreSettings({ theme: 'dark', maxActiveDownloads: 99, language: 'fra' });
  assert.equal(defaults.theme, 'dark');
  assert.equal(defaults.maxActiveDownloads, 3);
  assert.equal(defaults.language, 'fra');
  assert.throws(() => applySettings(defaults, { connectionsPerDownload: 0 }), /invalid-setting/);
  assert.throws(() => applySettings(defaults, { proxy: { mode: 'manual', url: 'ftp://x' } }), /invalid-setting/);
  assert.equal(applySettings(defaults, { proxy: { mode: 'manual', url: '127.0.0.1:8080' } }).proxy.mode, 'manual');
  assert.equal(applySettings(defaults, { schedule: { enabled: true, start: '23:30', stop: '', days: [5, 1] } }).schedule.days.join(), '1,5');
});

test('throttle limits throughput to the configured rate', async () => {
  const throttle = new Throttle(200 * 1024);
  const started = Date.now();
  for (let index = 0; index < 8; index += 1) await throttle.consume(50 * 1024);
  assert.ok(Date.now() - started >= 700, `took ${Date.now() - started}ms`);
});

test('downloads a small file and persists its completed state', async () => {
  const manager = await createManager('basic');
  const item = await manager.add({ url: `${base}/payload.txt`, fileName: 'sample.txt' });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(await fs.readFile(done.savePath, 'utf8'), 'wasel download test payload');
  const saved = JSON.parse(await fs.readFile(path.join(tempDirectory, 'basic.json'), 'utf8'));
  assert.equal(saved.items[0].status, 'completed');
  await manager.shutdown();
});

test('sends a browser User-Agent so sites that block unknown clients still work', async () => {
  const manager = await createManager('ua');
  const item = await manager.add({ url: `${base}/needs-browser-ua.zip` });
  await waitFor(finished(manager, item.id));
  assert.equal(manager.getDownload(item.id).status, 'completed', JSON.stringify(manager.getDownload(item.id).error));
  await manager.shutdown();
});

test('forwards browser cookies and the referring page for sign-in protected downloads', async () => {
  const manager = await createManager('cookies');
  const item = await manager.add({
    url: `${base}/members/file.zip`,
    referer: 'https://site.example/page',
    cookies: [{ name: 'session', value: 'abc123', domain: '127.0.0.1', hostOnly: true, path: '/' }]
  });
  await waitFor(finished(manager, item.id));
  assert.equal(manager.getDownload(item.id).status, 'completed', JSON.stringify(manager.getDownload(item.id).error));
  assert.equal(manager.getState().downloads[0].hasCookies, true);
  assert.equal(JSON.stringify(manager.exportState()).includes('abc123'), false, 'exports never contain cookies');
  await manager.shutdown();
});

test('keeps cookies set during a redirect chain', async () => {
  const manager = await createManager('redirect');
  const item = await manager.add({ url: `${base}/login-redirect` });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.fileName, 'needs-redirect-cookie.bin', 'the name comes from the final URL');
  await manager.shutdown();
});

test('names files from Content-Disposition, including Arabic UTF-8 names', async () => {
  const manager = await createManager('disposition');
  const item = await manager.add({ url: `${base}/download.php?id=7` });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.fileName, 'ملف عربي.zip');
  assert.equal(done.category, 'archives');
  assert.equal(await fs.readFile(done.savePath, 'utf8'), 'arabic name payload');
  await manager.shutdown();
});

test('downloads in parallel into one file, stays resumable when paused, and is byte-exact', async () => {
  log.maxConcurrent = 0;
  log.ranges = [];
  const manager = await createManager('parallel', { connectionsPerDownload: 4 });
  const item = await manager.add({ url: `${base}/big.bin` });
  await waitFor(() => manager.getDownload(item.id)?.receivedBytes > 512 * 1024);
  await manager.pause(item.id);
  const paused = manager.getDownload(item.id);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.chunks.length >= 2, 'a chunk map is kept for resuming');
  assert.equal((await fs.stat(`${paused.savePath}.part`)).size, BIG.length, 'the partial file is preallocated');
  await manager.resume(item.id);
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.ok(log.maxConcurrent >= 3, `expected parallel connections, saw ${log.maxConcurrent}`);
  assert.deepEqual(await fs.readFile(done.savePath), BIG);
  const leftovers = (await fs.readdir(path.dirname(done.savePath))).filter((file) => file.includes('.part'));
  assert.deepEqual(leftovers, []);
  await manager.shutdown();
});

test('resumes a chunked download after the app restarts', async () => {
  const name = 'restart';
  const first = await createManager(name, { connectionsPerDownload: 4 });
  const item = await first.add({ url: `${base}/big.bin`, fileName: 'restart.bin' });
  await waitFor(() => first.getDownload(item.id)?.receivedBytes > 1024 * 1024);
  await first.shutdown();
  const before = first.getDownload(item.id).receivedBytes;

  const second = new DownloadManager({ dataFile: path.join(tempDirectory, `${name}.json`), defaultFolder: path.join(tempDirectory, name) });
  await second.initialize();
  const restored = second.getDownload(item.id);
  assert.equal(restored.status, 'paused');
  assert.ok(restored.receivedBytes >= before * 0.9, 'progress survives the restart');
  log.ranges = [];
  await second.resume(item.id);
  await waitFor(finished(second, item.id));
  assert.equal(second.getDownload(item.id).status, 'completed', JSON.stringify(second.getDownload(item.id).error));
  assert.ok(log.ranges.every(([start]) => start > 0 || restored.chunks[0].done === 0), 'finished ranges are not downloaded again');
  assert.deepEqual(await fs.readFile(restored.savePath), BIG);
  await second.shutdown();
});

test('retries automatically after a dropped connection and resumes instead of restarting', async () => {
  log.flakyHits = 0;
  const manager = await createManager('flaky');
  const item = await manager.add({ url: `${base}/flaky.bin` });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.ok(log.flakyHits >= 2);
  assert.deepEqual(await fs.readFile(done.savePath), SLOW);
  await manager.shutdown();
});

test('falls back to one sequential stream when the server ignores ranges', async () => {
  const manager = await createManager('no-range', { connectionsPerDownload: 8 });
  const item = await manager.add({ url: `${base}/no-range.bin` });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.resumable, false);
  assert.deepEqual(await fs.readFile(done.savePath), SLOW);
  await manager.shutdown();
});

test('adapts when a server limits connections per client', async () => {
  const manager = await createManager('limited', { connectionsPerDownload: 8 });
  const item = await manager.add({ url: `${base}/limited.bin` });
  await waitFor(finished(manager, item.id), 30000);
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.deepEqual(await fs.readFile(done.savePath), BIG);
  await manager.shutdown();
});

test('reports an HTML sign-in page served in place of a file instead of saving it', async () => {
  const manager = await createManager('html');
  const item = await manager.add({ url: `${base}/expired.zip` });
  await waitFor(finished(manager, item.id));
  const failed = manager.getDownload(item.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'html-response');
  await manager.shutdown();
});

test('reports HTTP errors with a translatable code and does not retry them', async () => {
  const manager = await createManager('missing');
  const item = await manager.add({ url: `${base}/missing.zip` });
  await waitFor(finished(manager, item.id));
  assert.deepEqual(manager.getDownload(item.id).error, { code: 'http', params: { status: 404 } });
  await assert.rejects(manager.add({ url: 'ftp://example.com/file' }), /unsupported-protocol/);
  await manager.shutdown();
});

test('verifies a checksum after completion and can hash finished files', async () => {
  const expected = crypto.createHash('sha256').update('wasel download test payload').digest('hex');
  const manager = await createManager('checksum');
  const good = await manager.add({ url: `${base}/payload.txt`, fileName: 'good.txt', checksum: { expected } });
  const bad = await manager.add({ url: `${base}/payload.txt`, fileName: 'bad.txt', checksum: { expected: 'a'.repeat(64) } });
  await waitFor(() => finished(manager, good.id)() && finished(manager, bad.id)());
  assert.equal(manager.getDownload(good.id).checksum.ok, true);
  assert.equal(manager.getDownload(bad.id).checksum.ok, false);
  assert.equal(await manager.hash(good.id, 'sha256'), expected);
  await manager.shutdown();
});

test('probes a link for its real name, size and resumability before adding it', async () => {
  const manager = await createManager('probe');
  const info = await manager.probe({ url: `${base}/download.php?id=1` });
  assert.equal(info.fileName, 'ملف عربي.zip');
  assert.equal(info.totalBytes, Buffer.byteLength('arabic name payload'));
  assert.equal(info.resumable, true);
  await assert.rejects(manager.probe({ url: `${base}/missing.zip` }), /"status":404/);
  await manager.shutdown();
});

test('applies the global speed limit to active downloads', async () => {
  const manager = await createManager('limit', { speedLimit: 256 * 1024, connectionsPerDownload: 2 });
  const started = Date.now();
  const item = await manager.add({ url: `${base}/slow.bin` });
  await waitFor(finished(manager, item.id));
  assert.equal(manager.getDownload(item.id).status, 'completed');
  assert.ok(Date.now() - started >= 1300, `512 KB at 256 KB/s took ${Date.now() - started}ms`);
  await manager.shutdown();
});

test('downloads through a manually configured HTTP proxy', async () => {
  let proxied = 0;
  const proxy = http.createServer((request, response) => {
    proxied += 1;
    const upstream = http.request(request.url, { headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const manager = await createManager('proxy', { proxy: { mode: 'manual', url: `127.0.0.1:${proxy.address().port}` } });
  try {
    const item = await manager.add({ url: `${base}/payload.txt` });
    await waitFor(finished(manager, item.id));
    assert.equal(manager.getDownload(item.id).status, 'completed', JSON.stringify(manager.getDownload(item.id).error));
    assert.ok(proxied >= 1);
  } finally {
    await manager.shutdown();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('sorts files into category folders when enabled', async () => {
  const manager = await createManager('folders', { categoryFolders: true });
  const item = await manager.add({ url: `${base}/download.php?id=3` });
  await waitFor(finished(manager, item.id));
  const done = manager.getDownload(item.id);
  assert.equal(path.basename(path.dirname(done.savePath)), 'Compressed');
  await manager.shutdown();
});

test('reports an unusable save path with a translatable code', async () => {
  const manager = await createManager('blocked');
  const blocker = path.join(tempDirectory, 'not-a-directory');
  await fs.writeFile(blocker, 'x');
  const created = await manager.add({ url: `${base}/payload.txt`, startImmediately: false });
  const item = manager.getDownload(created.id);
  item.savePath = path.join(blocker, 'file.txt');
  await manager.resume(item.id);
  await waitFor(finished(manager, item.id));
  assert.equal(item.error.code, 'not-directory');
  assert.match(item.error.params.path, /not-a-directory/);
  await manager.shutdown();
});

test('migrates a version 1 library and keeps settings', async () => {
  const dataFile = path.join(tempDirectory, 'legacy.json');
  const folder = path.join(tempDirectory, 'legacy-files');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'old.mp4.part.segment-0'), 'x');
  await fs.writeFile(dataFile, JSON.stringify({
    items: [{ id: 'a', url: `${base}/payload.txt`, fileName: 'old.mp4', savePath: path.join(folder, 'old.mp4'), status: 'downloading', category: 'media', receivedBytes: 1, totalBytes: 10, error: 'boom', createdAt: new Date().toISOString() }],
    settings: { theme: 'light', language: 'deu', maxActiveDownloads: 5, connectionsPerDownload: 4, outputFolder: folder }
  }));
  const manager = new DownloadManager({ dataFile, defaultFolder: path.join(tempDirectory, 'legacy-fallback') });
  await manager.initialize();
  const item = manager.getDownload('a');
  assert.equal(item.status, 'paused');
  assert.equal(item.category, 'video');
  assert.equal(item.receivedBytes, 0);
  assert.deepEqual(item.error, { code: 'unknown', params: { detail: 'boom' } });
  assert.equal(manager.getState().settings.theme, 'light');
  assert.equal(manager.getState().settings.language, 'deu');
  assert.equal(manager.getState().settings.outputFolder, folder);
  assert.deepEqual((await fs.readdir(folder)).filter((file) => file.includes('segment')), []);
  await manager.shutdown();
});
