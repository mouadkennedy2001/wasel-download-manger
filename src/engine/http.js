const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { WaselError } = require('./errors');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 15;
const IDLE_TIMEOUT = 30_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

let cachedCertificates;

// Trust Windows' certificate store as well as Node's bundled roots. Antivirus HTTPS
// scanning and corporate gateways install their roots there, and without them those
// machines fail every HTTPS download with "unable to get local issuer certificate".
function trustedCertificates() {
  if (cachedCertificates) return cachedCertificates;
  const roots = new Set(tls.rootCertificates);
  try {
    if (typeof tls.getCACertificates === 'function') {
      for (const certificate of tls.getCACertificates('system')) roots.add(certificate);
    }
  } catch {
    // Older runtimes do not expose the system store; bundled roots still work.
  }
  cachedCertificates = [...roots];
  return cachedCertificates;
}

class CookieJar {
  constructor(cookies = []) {
    this.cookies = [];
    for (const cookie of cookies) this.add(cookie);
  }

  add(cookie) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return;
    const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    if (!domain) return;
    const entry = {
      name: cookie.name,
      value: cookie.value,
      domain,
      hostOnly: Boolean(cookie.hostOnly),
      path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
      secure: Boolean(cookie.secure)
    };
    this.cookies = this.cookies.filter((existing) =>
      !(existing.name === entry.name && existing.domain === entry.domain && existing.path === entry.path));
    this.cookies.push(entry);
  }

  // A raw "Cookie:" string typed by the user applies to the host it was given for.
  addHeader(header, rawUrl) {
    if (typeof header !== 'string' || !header.trim()) return;
    const host = new URL(rawUrl).hostname;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      this.add({ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), domain: host, hostOnly: true });
    }
  }

  setFromResponse(setCookie, rawUrl) {
    if (!setCookie) return;
    const url = new URL(rawUrl);
    for (const line of [].concat(setCookie)) {
      const [pair, ...attributes] = String(line).split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const cookie = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: url.hostname, hostOnly: true, path: '/' };
      let expired = false;
      for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split('=');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join('=').trim();
        if (key === 'domain' && value) {
          const domain = value.toLowerCase().replace(/^\./, '');
          if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
            cookie.domain = domain;
            cookie.hostOnly = false;
          }
        } else if (key === 'path' && value.startsWith('/')) cookie.path = value;
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'max-age' && Number(value) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(value) < Date.now()) expired = true;
      }
      if (expired) {
        this.cookies = this.cookies.filter((existing) => !(existing.name === cookie.name && existing.domain === cookie.domain));
      } else {
        this.add(cookie);
      }
    }
  }

  headerFor(rawUrl) {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const matches = this.cookies.filter((cookie) => {
      const domainMatch = cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      const pathMatch = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
      return domainMatch && pathMatch && (!cookie.secure || url.protocol === 'https:');
    });
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  toJSON() {
    return this.cookies;
  }
}

function proxyAuthorization(proxyUrl) {
  if (!proxyUrl.username) return {};
  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };
}

// HTTPS through an HTTP proxy: open a CONNECT tunnel, then run TLS inside it.
function tunnelConnection(proxyUrl, target) {
  return (options, onCreate) => {
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
    const socket = proxyUrl.protocol === 'https:'
      ? tls.connect({ host: proxyUrl.hostname, port: proxyPort, servername: proxyUrl.hostname, ca: trustedCertificates() })
      : net.connect({ host: proxyUrl.hostname, port: proxyPort });
    const authority = `${target.hostname}:${target.port || 443}`;
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      socket.destroy();
      onCreate(Object.assign(error, { code: error.code || 'ERR_PROXY' }));
    };
    socket.setTimeout(IDLE_TIMEOUT, () => fail(new Error('Proxy connection timed out')));
    socket.once('error', fail);
    socket.once(proxyUrl.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const headers = Object.entries({ Host: authority, ...proxyAuthorization(proxyUrl) })
        .map(([key, value]) => `${key}: ${value}\r\n`).join('');
      socket.write(`CONNECT ${authority} HTTP/1.1\r\n${headers}\r\n`);
    });
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      const status = Number(buffer.toString('latin1', 0, end).split(' ')[1]);
      if (status !== 200) {
        fail(new WaselError('proxy', { status }));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        ca: trustedCertificates(),
        ALPNProtocols: ['http/1.1']
      });
      onCreate(null, secure);
    };
    socket.on('data', onData);
    return undefined;
  };
}

class HttpClient {
  constructor({ userAgent = () => '', resolveProxy = async () => null } = {}) {
    this.userAgent = userAgent;
    this.resolveProxy = resolveProxy;
    this.agents = {
      'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
      'https:': new https.Agent({ keepAlive: true, maxSockets: 64, ca: trustedCertificates() })
    };
  }

  baseHeaders() {
    return {
      'User-Agent': this.userAgent() || DEFAULT_USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'identity'
    };
  }

  // Opens a GET request, following redirects manually so cookies, Referer and Range
  // are recomputed for every hop. Resolves once response headers arrive.
  async open(rawUrl, { headers = {}, jar, referer, control, redirects = 0 } = {}) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new WaselError('invalid-url', { url: String(rawUrl).slice(0, 200) });
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new WaselError('bad-redirect', { url: url.href.slice(0, 200) });
    if (redirects > MAX_REDIRECTS) throw new WaselError('too-many-redirects', {});
    if (control?.stopReason) throw Object.assign(new Error('stopped'), { code: 'ERR_STOPPED' });

    const requestHeaders = { ...this.baseHeaders(), ...headers };
    if (referer) requestHeaders.Referer = referer;
    const cookie = jar?.headerFor(url.href);
    if (cookie) requestHeaders.Cookie = cookie;

    const proxy = await this.resolveProxy(url.href);
    const options = { method: 'GET', headers: requestHeaders };
    let transport = url.protocol === 'https:' ? https : http;
    let target = url;
    if (proxy) {
      const proxyUrl = new URL(proxy);
      if (url.protocol === 'https:') {
        options.agent = false;
        options.createConnection = tunnelConnection(proxyUrl, url);
      } else {
        transport = proxyUrl.protocol === 'https:' ? https : http;
        target = proxyUrl;
        options.path = url.href;
        options.agent = false;
        options.headers = { ...requestHeaders, Host: url.host, ...proxyAuthorization(proxyUrl) };
        if (proxyUrl.protocol === 'https:') options.ca = trustedCertificates();
      }
    } else {
      options.agent = this.agents[url.protocol];
    }

    const { response, request } = await new Promise((resolve, reject) => {
      const request = transport.request(target, options, (response) => resolve({ response, request }));
      control?.requests.add(request);
      request.once('close', () => control?.requests.delete(request));
      request.setTimeout(IDLE_TIMEOUT, () => {
        request.destroy(Object.assign(new Error('Connection timed out'), { code: 'ERR_TIMEOUT' }));
      });
      // Persistent listener: socket errors can arrive after the response has started,
      // and the body consumer sees them through the response stream instead.
      request.on('error', reject);
      request.end();
    });

    jar?.setFromResponse(response.headers['set-cookie'], url.href);
    if (REDIRECT_CODES.has(response.statusCode) && response.headers.location) {
      response.resume();
      request.destroy();
      const nextUrl = new URL(response.headers.location, url).href;
      return this.open(nextUrl, { headers, jar, referer, control, redirects: redirects + 1 });
    }
    return { response, request, finalUrl: url.href };
  }

  destroy() {
    for (const agent of Object.values(this.agents)) agent.destroy();
  }
}

module.exports = { CookieJar, DEFAULT_USER_AGENT, HttpClient, trustedCertificates };
