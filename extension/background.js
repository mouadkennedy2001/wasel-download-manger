import { createDownloadProtocolUrl } from './link-protocol.js';
import { buildCapturePayload, shouldCaptureDownload } from './download-capture.js';

const api = globalThis.browser || globalThis.chrome;
const PORTS = [47215, 47216, 47217, 47218];
const MENU_ID = 'wasel-download-link';

let bridgePort = null;

async function pingPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/wasel/v1/ping`, { cache: 'no-store' });
    if (!response.ok) return false;
    return (await response.json()).app === 'wasel';
  } catch {
    return false;
  }
}

export async function findBridge() {
  if (bridgePort && await pingPort(bridgePort)) return bridgePort;
  bridgePort = null;
  for (const port of PORTS) {
    if (await pingPort(port)) {
      bridgePort = port;
      return port;
    }
  }
  return null;
}

// Sends links to the running app. When the app is not reachable, a single link falls
// back to the wasel:// protocol so the app can still receive it once launched.
export async function sendToWasel(payload) {
  const port = await findBridge();
  if (port) {
    const response = await fetch(`http://127.0.0.1:${port}/wasel/v1/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Wasel rejected the download.');
    return result;
  }
  if (payload.urls.length === 1) {
    await api.tabs.create({ url: createDownloadProtocolUrl(payload.urls[0]), active: false });
    return null;
  }
  throw new Error('Wasel is not running.');
}

async function cookiesFor(url) {
  if (!api.cookies?.getAll) return [];
  try {
    return await api.cookies.getAll({ url });
  } catch {
    return [];
  }
}

function userAgent() {
  return globalThis.navigator?.userAgent || '';
}

async function captureDownload(download) {
  const settings = await api.storage.local.get({ captureBrowserDownloads: true });
  if (!shouldCaptureDownload(download, settings.captureBrowserDownloads)) return;

  const cookies = await cookiesFor(download.finalUrl || download.url);
  const payload = buildCapturePayload(download, { cookies, userAgent: userAgent() });
  try {
    await sendToWasel(payload);
    await api.downloads.cancel(download.id);
  } catch (error) {
    // Leave the browser download running when Wasel cannot take it.
    console.error('Wasel could not take this download.', error);
  }
}

api.downloads.onCreated.addListener((download) => {
  captureDownload(download).catch((error) => console.error('Wasel capture failed.', error));
});

if (api.contextMenus) {
  api.runtime.onInstalled.addListener(() => {
    api.contextMenus.create({
      id: MENU_ID,
      title: 'Download with Wasel',
      contexts: ['link', 'video', 'audio', 'image']
    });
  });
  api.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    const url = info.linkUrl || info.srcUrl;
    if (!url || !/^https?:\/\//i.test(url)) return;
    const cookies = await cookiesFor(url);
    await sendToWasel({
      urls: [url],
      referer: info.pageUrl || tab?.url || '',
      userAgent: userAgent(),
      cookies: cookies.map(({ name, value, domain, path, secure, hostOnly }) => ({ name, value, domain, path, secure, hostOnly })),
      source: 'context'
    }).catch((error) => console.error('Wasel could not take this link.', error));
  });
}

api.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'wasel:status') {
    findBridge().then((port) => reply({ running: Boolean(port), port }));
    return true;
  }
  if (message?.type === 'wasel:send') {
    sendToWasel(message.payload).then(
      (result) => reply({ ok: true, result }),
      (error) => reply({ ok: false, error: error.message })
    );
    return true;
  }
  return undefined;
});
