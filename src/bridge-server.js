const http = require('node:http');

const PORTS = [47215, 47216, 47217, 47218];
const MAX_BODY = 2 * 1024 * 1024;
const EXTENSION_ORIGIN = /^(chrome|moz|ms-browser|safari-web)-extension:\/\/[\w.-]+$/i;

// Local endpoint the browser extension talks to. Only extension origins are accepted:
// a web page cannot forge an extension Origin header, so sites cannot push downloads.
function createBridgeServer({ version, onDownload, getInfo = () => ({}) }) {
  let server = null;
  let port = null;

  function reply(response, status, body, origin) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers.Vary = 'Origin';
    }
    response.writeHead(status, headers);
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  async function handle(request, response) {
    const origin = request.headers.origin;
    if (!origin || !EXTENSION_ORIGIN.test(origin)) {
      reply(response, 403, { ok: false, error: 'forbidden-origin' });
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'OPTIONS') {
      reply(response, 204, undefined, origin);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/wasel/v1/ping') {
      reply(response, 200, { ok: true, app: 'wasel', version, ...getInfo() }, origin);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/wasel/v1/downloads') {
      const body = await readJson(request);
      const payload = sanitizePayload(body);
      const result = await onDownload(payload);
      reply(response, 200, { ok: true, ...result }, origin);
      return;
    }
    reply(response, 404, { ok: false, error: 'not-found' }, origin);
  }

  async function start() {
    for (const candidate of PORTS) {
      try {
        server = http.createServer((request, response) => {
          handle(request, response).catch((error) => {
            if (!response.headersSent) reply(response, error.status || 400, { ok: false, error: error.code || 'bad-request' }, request.headers.origin);
          });
        });
        server.headersTimeout = 10_000;
        server.requestTimeout = 15_000;
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(candidate, '127.0.0.1', resolve);
        });
        port = candidate;
        return port;
      } catch {
        server?.close();
        server = null;
      }
    }
    return null;
  }

  function stop() {
    server?.close();
    server = null;
  }

  return { start, stop, get port() { return port; } };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { code: 'too-large', status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { code: 'invalid-json' }));
      }
    });
    request.on('error', reject);
  });
}

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizePayload(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Invalid payload'), { code: 'invalid-payload' });
  const rawUrls = Array.isArray(body.urls) ? body.urls : [body.url];
  const urls = [...new Set(rawUrls.map(httpUrl).filter(Boolean))].slice(0, 500);
  if (!urls.length) throw Object.assign(new Error('No valid link'), { code: 'invalid-url' });
  const cookies = Array.isArray(body.cookies) ? body.cookies.slice(0, 300).filter((cookie) =>
    cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string')
    .map((cookie) => ({
      name: cookie.name.slice(0, 256),
      value: cookie.value.slice(0, 8192),
      domain: cookie.domain.slice(0, 256),
      path: text(cookie.path, 1024) || '/',
      secure: Boolean(cookie.secure),
      hostOnly: Boolean(cookie.hostOnly)
    })) : [];
  const totalBytes = Number(body.totalBytes);
  return {
    urls,
    fileName: urls.length === 1 ? text(body.fileName, 255) : '',
    referer: httpUrl(body.referer) || '',
    userAgent: text(body.userAgent, 512),
    mime: text(body.mime, 120),
    totalBytes: Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : 0,
    cookies,
    source: ['capture', 'context', 'popup', 'page'].includes(body.source) ? body.source : 'popup',
    pageTitle: text(body.pageTitle, 300)
  };
}

module.exports = { PORTS, createBridgeServer, sanitizePayload };
