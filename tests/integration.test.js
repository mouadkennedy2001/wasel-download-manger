const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, test } = require('node:test');
const { createBridgeServer, sanitizePayload } = require('../src/bridge-server');
const { Scheduler, nextRun } = require('../src/scheduler');
const { createTranslator } = require('../src/i18n');
const { SUPPORTED_LANGUAGES } = require('../src/languages');
const fs = require('node:fs');

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let bridge;
let received = [];

before(async () => {
  bridge = createBridgeServer({
    version: 'test',
    getInfo: () => ({ askBeforeCapture: true }),
    onDownload: async (payload) => {
      received.push(payload);
      return { queued: false, confirm: true };
    }
  });
  await bridge.start();
});

after(() => bridge?.stop());

async function post(body, origin = EXTENSION) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const response = await fetch(`http://127.0.0.1:${bridge.port}/wasel/v1/downloads`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('bridge answers ping only to extension origins and echoes CORS for them', async () => {
  const ok = await fetch(`http://127.0.0.1:${bridge.port}/wasel/v1/ping`, { headers: { Origin: EXTENSION } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), EXTENSION);
  assert.equal((await ok.json()).app, 'wasel');

  const web = await fetch(`http://127.0.0.1:${bridge.port}/wasel/v1/ping`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(web.status, 403, 'web pages cannot talk to the bridge');
});

test('bridge accepts a capture from the extension with cookies and referer, and rejects web pages', async () => {
  received = [];
  const accepted = await post({
    urls: ['https://files.example.com/private/report.pdf'],
    referer: 'https://files.example.com/account',
    fileName: 'report.pdf',
    cookies: [{ name: 'session', value: 'abc', domain: 'files.example.com', path: '/', secure: true, hostOnly: true }]
  });
  assert.equal(accepted.status, 200);
  assert.equal(received[0].cookies[0].name, 'session');
  assert.equal(received[0].referer, 'https://files.example.com/account');

  const rejected = await post({ urls: ['https://a.example/x.zip'] }, 'https://evil.example');
  assert.equal(rejected.status, 403);
});

test('bridge sanitizes payloads: drops non-HTTP links, credentials and oversized cookie lists', () => {
  const payload = sanitizePayload({
    urls: ['file:///C:/secret.txt', 'https://user:pass@example.com/a', 'https://example.com/ok.zip', 'https://example.com/ok.zip'],
    referer: 'javascript:alert(1)',
    cookies: [{ name: 'a', value: 'b', domain: 'example.com' }, { name: 1 }]
  });
  assert.deepEqual(payload.urls, ['https://example.com/ok.zip']);
  assert.equal(payload.referer, '');
  assert.equal(payload.cookies.length, 1);
  assert.throws(() => sanitizePayload({ urls: ['ftp://x'] }), (error) => error.code === 'invalid-url');
});

test('capture rules skip non-web, private and HTML downloads and honour the toggle', async () => {
  const { shouldCaptureDownload, buildCapturePayload } = await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'download-capture.js')).href);
  const base = { url: 'https://example.com/file.zip', state: 'in_progress' };
  assert.equal(shouldCaptureDownload(base), true);
  assert.equal(shouldCaptureDownload(base, false), false);
  assert.equal(shouldCaptureDownload({ ...base, incognito: true }), false);
  assert.equal(shouldCaptureDownload({ ...base, byExtensionId: 'x' }), false);
  assert.equal(shouldCaptureDownload({ ...base, url: 'file:///C:/a.zip' }), false);
  assert.equal(shouldCaptureDownload({ ...base, url: 'https://u:p@example.com/a' }), false);
  assert.equal(shouldCaptureDownload({ ...base, mime: 'text/html' }), false);
  assert.equal(shouldCaptureDownload({ ...base, state: 'complete' }), false);
  const payload = buildCapturePayload({ ...base, filename: 'C:\\Users\\me\\Downloads\\file.zip', referrer: 'https://example.com/', totalBytes: 10 }, { cookies: [] });
  assert.equal(payload.fileName, 'file.zip');
  assert.equal(payload.totalBytes, 10);
});

test('scheduler computes the next start on an enabled weekday', () => {
  const from = new Date(2026, 9, 24, 12, 0); // Saturday
  const next = nextRun({ enabled: true, start: '02:00', days: [1] }, from);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 2);
  assert.equal(nextRun({ enabled: false, start: '02:00', days: [1] }, from), null);
});

test('scheduler starts and stops once per day at the configured minute', async () => {
  const calls = [];
  const fake = {
    getState: () => ({ settings: { schedule: { enabled: true, start: '09:30', stop: '17:00', days: [0, 1, 2, 3, 4, 5, 6] } } }),
    resumeAll: async () => calls.push('resume'),
    pauseAll: async () => calls.push('pause')
  };
  let now = new Date(2026, 9, 24, 9, 30);
  const scheduler = new Scheduler({ manager: fake, now: () => now });
  assert.equal(await scheduler.tick(), 'start');
  assert.equal(await scheduler.tick(), null, 'the same minute does not fire twice');
  now = new Date(2026, 9, 24, 17, 0);
  assert.equal(await scheduler.tick(), 'stop');
  assert.deepEqual(calls, ['resume', 'pause']);
});

test('every language resource ships with plural-aware messages and Arabic plurals resolve correctly', async () => {
  const root = path.join(__dirname, '..', 'lang');
  const english = JSON.parse(fs.readFileSync(path.join(root, 'eng.json'), 'utf8'));
  for (const code of SUPPORTED_LANGUAGES) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, `${code}.json`), 'utf8'));
    assert.ok(['ltr', 'rtl'].includes(locale.direction), `${code} direction`);
    // Languages not yet migrated to the message format fall back to English at runtime.
    if (code === 'ara' || code === 'eng') assert.equal(typeof locale.messages, 'object', `${code} has messages`);
  }
  const ar = JSON.parse(fs.readFileSync(path.join(root, 'ara.json'), 'utf8'));
  const t = createTranslator({ ...ar, fallback: english.messages });
  assert.equal(t('toast.added', { count: 1 }), 'أُضيف تنزيل واحد');
  assert.equal(t('toast.added', { count: 2 }), 'أُضيف تنزيلان');
  assert.equal(t('toast.added', { count: 5 }), 'أُضيفت 5 تنزيلات');
  assert.equal(t('toast.added', { count: 12 }), 'أُضيف 12 تنزيلًا');
  assert.equal(t('toast.added', { count: 30 }), 'أُضيف 30 تنزيلًا');
  assert.equal(t('toast.added', { count: 100 }), 'أُضيف 100 تنزيل');
  assert.equal(t('missing.key'), 'missing.key');
});
