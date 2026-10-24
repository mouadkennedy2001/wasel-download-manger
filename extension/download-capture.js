// Decides whether a browser download should move to Wasel. Kept free of browser APIs so
// the rules can be unit-tested in Node.
const SKIPPED_MIME = /^(text\/html|application\/xhtml)/i;

export function shouldCaptureDownload(download, enabled = true) {
  if (!enabled || !download || download.incognito || download.byExtensionId) return false;
  if (download.state && download.state !== 'in_progress') return false;
  const address = download.finalUrl || download.url;
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch {
    return false;
  }
  // Web pages that a download link happens to point to are left to the browser.
  if (download.mime && SKIPPED_MIME.test(download.mime)) return false;
  return true;
}

// Only the fields the desktop app needs; nothing from the browser profile beyond that.
export function buildCapturePayload(download, { cookies = [], userAgent = '', source = 'capture' } = {}) {
  const address = download.finalUrl || download.url;
  return {
    urls: [address],
    referer: download.referrer || '',
    fileName: fileNameFrom(download.filename),
    mime: download.mime || '',
    totalBytes: Number.isSafeInteger(download.totalBytes) && download.totalBytes > 0 ? download.totalBytes : 0,
    userAgent,
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      hostOnly: cookie.hostOnly
    })),
    source
  };
}

function fileNameFrom(fullPath) {
  if (typeof fullPath !== 'string' || !fullPath) return '';
  return fullPath.split(/[\\/]/).pop() || '';
}
