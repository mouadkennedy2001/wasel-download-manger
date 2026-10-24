const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { DownloadManager } = require('../src/download-manager');
const { sniffPage } = require('../src/engine/sniff');
const { bestVariant, mediaSegments } = require('../src/engine/hls');

const KEY = crypto.randomBytes(16);
const SEGMENTS = [Buffer.alloc(40000, 1), Buffer.alloc(52000, 2), Buffer.alloc(31000, 3)];
const MOVIE = Buffer.alloc(300 * 1024, 9);
let tempDirectory;
let server;
let base;

function encrypt(data, sequence) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence, 12);
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wasel-anylink-'));
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (type, body, status = 200) => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    };
    if (url.pathname === '/watch') {
      send('text/html; charset=utf-8', `<html><head><title>My Holiday Film | VideoSite</title>
        <meta property="og:image" content="/thumb.jpg"></head><body>
        <video controls><source src="/media/movie.mp4" type="video/mp4"></video>
        <a href="/files/notes.pdf">Notes</a><a href="/about">About</a></body></html>`);
    } else if (url.pathname === '/media/movie.mp4') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MOVIE.length });
      response.end(MOVIE);
    } else if (url.pathname === '/live/master.m3u8') {
      send('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhigh/index.m3u8\n');
    } else if (url.pathname === '/live/high/index.m3u8') {
      send('application/vnd.apple.mpegurl', `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="/live/key.bin"\n${SEGMENTS.map((_, index) => `#EXTINF:4.0,\nseg${index}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`);
    } else if (url.pathname === '/live/key.bin') {
      response.writeHead(200, { 'Content-Length': 16 });
      response.end(KEY);
    } else if (/^\/live\/high\/seg(\d)\.ts$/.test(url.pathname)) {
      const index = Number(url.pathname.match(/seg(\d)/)[1]);
      const data = encrypt(SEGMENTS[index], index);
      response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length });
      response.end(data);
    } else {
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
  const manager = new DownloadManager({ dataFile: path.join(tempDirectory, `${name}.json`), defaultFolder: path.join(tempDirectory, name) });
  await manager.initialize();
  if (Object.keys(settings).length) await manager.updateSettings(settings);
  return manager;
}

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('finds videos, Open Graph media and file links inside a page, video first', () => {
  const html = `<meta property="og:video" content="https://cdn.x/clip.mp4"><video src="/v/main.webm"></video>
    <script>var cfg = {"hls":"https:\\/\\/cdn.x\\/live\\/index.m3u8"}</script>
    <a href="/docs/guide.pdf">Guide</a><a href="/contact">Contact</a><img src="/logo.png">`;
  const found = sniffPage(html, 'https://site.example/page');
  assert.equal(found[0].kind, 'stream');
  assert.ok(found.some((entry) => entry.url === 'https://cdn.x/clip.mp4'));
  assert.ok(found.some((entry) => entry.url === 'https://site.example/v/main.webm'));
  assert.ok(found.some((entry) => entry.url === 'https://site.example/docs/guide.pdf'));
  assert.ok(!found.some((entry) => entry.url.endsWith('/contact')), 'ordinary page links are ignored');
});

test('parses HLS master and media playlists', () => {
  const variant = bestVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9\nb.m3u8\n', 'https://x/live/m.m3u8');
  assert.equal(variant.url, 'https://x/live/b.m3u8');
  const segments = mediaSegments('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\none.ts\n#EXTINF:2,\ntwo.ts\n', 'https://x/live/b.m3u8');
  assert.deepEqual(segments.map((segment) => [segment.url, segment.sequence]), [['https://x/live/one.ts', 7], ['https://x/live/two.ts', 8]]);
  assert.throws(() => mediaSegments('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:2,\na.ts\n', 'https://x/'), /Unsupported HLS/);
});

test('probing a page link lists the media found on it', async () => {
  const manager = await createManager('probe-page');
  const info = await manager.probe({ url: `${base}/watch` });
  assert.equal(info.page, true);
  assert.equal(info.title, 'My Holiday Film | VideoSite');
  assert.equal(info.candidates[0].url, `${base}/media/movie.mp4`);
  assert.ok(info.candidates.some((entry) => entry.url.endsWith('/files/notes.pdf')));
  await manager.shutdown();
});

test('a page link downloads the video on that page, named after the page title', async () => {
  const manager = await createManager('page-link');
  const item = await manager.add({ url: `${base}/watch` });
  await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done.fileName, 'My Holiday Film.mp4');
  assert.equal(done.pageUrl, `${base}/watch`);
  assert.deepEqual(await fs.readFile(done.savePath), MOVIE);
  await manager.shutdown();
});

test('downloads an encrypted HLS stream into one decrypted .ts file', async () => {
  const manager = await createManager('hls');
  const item = await manager.add({ url: `${base}/live/master.m3u8` });
  assert.equal(item.kind, 'hls');
  assert.equal(item.fileName, 'master.ts');
  await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));
  const done = manager.getDownload(item.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.deepEqual(await fs.readFile(done.savePath), Buffer.concat(SEGMENTS));
  assert.equal(done.category, 'video');
  await manager.shutdown();
});

test('turbo mode uses 32 connections and ignores the speed limit', async () => {
  const manager = await createManager('turbo', { speedLimit: 1024, turbo: true });
  assert.equal(manager.connectionsFor({}), 32);
  assert.equal(manager.throttle.rate, 0);
  await manager.updateSettings({ turbo: false });
  assert.equal(manager.connectionsFor({}), 8);
  assert.equal(manager.throttle.rate, 1024);
  await manager.shutdown();
});
