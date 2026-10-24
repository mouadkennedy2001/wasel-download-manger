// Renders the real app against an isolated profile and a local, throttled file server,
// then captures each screen for the website and for visual review.
//   npx electron scripts/screenshot.js            (SHOT_THEME=dark SHOT_LANG=eng SHOT_OUT=dir)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const theme = process.env.SHOT_THEME || 'light';
const language = process.env.SHOT_LANG || 'ara';
const outDir = path.resolve(process.env.SHOT_OUT || path.join(__dirname, '..', 'website', 'assets', 'screens'));
const profile = fs.mkdtempSync(path.join(process.env.SHOT_TMP || os.tmpdir(), 'wasel-shot-'));
const downloads = path.join(profile, 'files');
fs.mkdirSync(path.join(profile, 'downloads'), { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const MB = 1024 * 1024;
const files = {
  '/Blender-4.5-windows-x64.msi': { size: 412 * MB, rate: 5.8 * MB },
  '/Interstellar-2014-2160p.mkv': { size: 2.1 * 1024 * MB, rate: 9.4 * MB },
  '/Final-Report-Q3.pdf': { size: 38 * MB, rate: 0.9 * MB }
};

const server = http.createServer((request, response) => {
  const file = files[decodeURIComponent(request.url)];
  if (!file) {
    response.writeHead(404);
    response.end();
    return;
  }
  const size = Math.round(file.size);
  const match = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : size - 1;
  response.writeHead(match ? 206 : 200, {
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  });
  const chunk = Buffer.alloc(64 * 1024, 7);
  let sent = start;
  const perTick = Math.max(16 * 1024, Math.round(file.rate / 8 / 20));
  const timer = setInterval(() => {
    if (response.destroyed || sent > end) {
      clearInterval(timer);
      if (!response.destroyed) response.end();
      return;
    }
    const length = Math.min(perTick, end - sent + 1, chunk.length);
    response.write(chunk.subarray(0, length));
    sent += length;
  }, 50);
  response.on('close', () => clearInterval(timer));
});

function iso(daysAgo, hours = 10, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function completed(id, url, fileName, category, size, daysAgo, hours, extra = {}) {
  return {
    id, url, finalUrl: url, fileName, savePath: path.join(downloads, fileName), status: 'completed', category,
    receivedBytes: size, totalBytes: size, speed: 0, resumable: true, createdAt: iso(daysAgo, hours - 1), completedAt: iso(daysAgo, hours, 12),
    error: null, request: {}, chunks: null, ...extra
  };
}

const library = {
  version: 2,
  settings: { theme, language, accent: 'blue', outputFolder: downloads, connectionsPerDownload: 8, maxActiveDownloads: 3, speedLimit: 0 },
  items: [
    { id: 'paused-1', url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04.3-desktop-amd64.iso', fileName: 'ubuntu-24.04.3-desktop-amd64.iso', savePath: path.join(downloads, 'ubuntu-24.04.3-desktop-amd64.iso'), status: 'paused', category: 'archives', receivedBytes: 0, totalBytes: 6.1 * 1024 * MB, createdAt: iso(0, 9), request: {} },
    { id: 'error-1', url: 'https://cdn.example-files.net/members/course-week-4.zip', fileName: 'course-week-4.zip', savePath: path.join(downloads, 'course-week-4.zip'), status: 'error', category: 'archives', receivedBytes: 0, totalBytes: 0, createdAt: iso(0, 8), error: { code: 'http', params: { status: 403 } }, request: {} },
    completed('done-1', 'https://github.com/obsproject/obs-studio/releases/download/31.1/OBS-Studio-31.1-Windows-x64-Installer.exe', 'OBS-Studio-31.1-Windows-x64-Installer.exe', 'software', 148 * MB, 0, 11, { checksum: { algorithm: 'sha256', expected: 'a', actual: 'a', ok: true } }),
    completed('done-2', 'https://download.example.org/podcast/episode-112.mp3', 'بودكاست — الحلقة 112.mp3', 'music', 64 * MB, 0, 9),
    completed('done-3', 'https://images.unsplash.com/photo-sahara-dunes.jpg', 'sahara-dunes-8k.jpg', 'images', 23.4 * MB, 1, 18),
    completed('done-4', 'https://www.example.com/docs/thesis-final.docx', 'thesis-final.docx', 'documents', 4.2 * MB, 1, 15),
    completed('done-5', 'https://mirror.example.net/vlc/vlc-3.0.21-win64.exe', 'vlc-3.0.21-win64.exe', 'software', 41 * MB, 4, 12),
    completed('done-6', 'https://archive.example.org/films/nature-documentary-1080p.mp4', 'nature-documentary-1080p.mp4', 'video', 1.4 * 1024 * MB, 5, 20)
  ]
};
fs.writeFileSync(path.join(profile, 'downloads', 'library.json'), JSON.stringify(library));
fs.writeFileSync(path.join(profile, 'tray-hint-shown'), '1');
fs.writeFileSync(path.join(profile, 'window-state.json'), JSON.stringify({ width: 1280, height: 800 }));

process.env.WASEL_USER_DATA = profile;
process.env.WASEL_NO_MATERIAL = '1';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(window, name) {
  await wait(700);
  const image = await window.webContents.capturePage();
  const file = path.join(outDir, `${name}-${theme}-${language}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log('saved', file);
}

app.on('browser-window-created', (_event, window) => {
  window.on('closed', () => console.log('window closed'));
  window.webContents.on('render-process-gone', (_e, d) => console.log('gone', JSON.stringify(d)));
  window.webContents.on('console-message', (e) => console.log('console', e.level, e.message));
  setTimeout(async () => {
    try {
      const run = (code) => window.webContents.executeJavaScript(code);
      await wait(1500);
      const port = server.address().port;
      for (const name of Object.keys(files)) {
        await run(`window.wasel.add({ url: 'http://127.0.0.1:${port}${name}', startImmediately: true })`);
      }
      await wait(6500);
      await capture(window, 'main');
      await run(`document.querySelector('.row-item')?.click(); document.querySelector('[data-command="toggle-inspector"]').click();`);
      await wait(2500);
      await capture(window, 'inspector');
      await run(`document.querySelector('[data-command="toggle-inspector"]').click(); document.querySelector('[data-command="add"]').click();`);
      await wait(300);
      await run(`const input = document.querySelector('#urlInput'); input.value = 'https://github.com/obsproject/obs-studio/releases/download/32.0/OBS-Studio-32.0-Windows-x64.zip\\nhttps://example.com/photos/trip-[01-03].jpg'; input.dispatchEvent(new Event('input'));`);
      await wait(2500);
      await capture(window, 'add');
      await run(`document.querySelector('[data-close-sheet]').click();`);
      await wait(300);
      await run(`document.querySelector('[data-command="settings"]').click();`);
      await wait(400);
      await capture(window, 'settings');
      await run(`document.querySelector('[data-pane="downloads"].settings-tab').click();`);
      await capture(window, 'settings-downloads');
      await run(`document.querySelector('[data-pane="browser"].settings-tab').click();`);
      await capture(window, 'settings-browser');
      await run(`document.querySelector('[data-close-sheet]').click(); document.querySelector('[data-filter="completed"]').click();`);
      await capture(window, 'completed');
    } catch (error) {
      console.error(error);
    } finally {
      server.close();
      app.exit(0);
    }
  }, 4000);
});

server.listen(0, '127.0.0.1', () => {
  require('../src/main.js');
});
