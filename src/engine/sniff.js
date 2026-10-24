// Finds downloadable things inside a web page, so a page link (not a direct file link)
// can still be downloaded: <video>/<audio>/<source>, Open Graph media, JSON-LD
// contentUrl, HLS playlists referenced from scripts, and links to files.
const FILE_LINK = /\.(zip|rar|7z|tar|gz|tgz|xz|bz2|iso|img|exe|msi|msix|apk|dmg|pkg|deb|rpm|mp4|mkv|avi|mov|webm|m4v|mp3|flac|wav|m4a|aac|ogg|opus|pdf|epub|docx?|xlsx?|pptx?|csv|psd|jpg|jpeg|png|gif|webp|svg|m3u8|torrent)(?:[?#]|$)/i;
const MEDIA_TAG = /<(video|audio|source|track|embed)\b[^>]*?\s(?:src|data-src)\s*=\s*["']([^"']+)["']/gi;
const META_MEDIA = /<meta\b[^>]*?(?:property|name)\s*=\s*["'](og:video(?::secure_url|:url)?|og:audio(?::secure_url)?|twitter:player:stream)["'][^>]*?content\s*=\s*["']([^"']+)["']|<meta\b[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](og:video(?::secure_url|:url)?|og:audio(?::secure_url)?)["']/gi;
const ANCHOR = /<a\b[^>]*?\shref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
const CONTENT_URL = /"(?:contentUrl|embedUrl|downloadUrl)"\s*:\s*"([^"]+)"/gi;
const QUOTED_STREAM = /["'](https?:\/\/[^"'\s]+?\.(?:m3u8|mp4|webm|mp3)(?:\?[^"'\s]*)?)["']/gi;

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

function absolute(raw, base) {
  try {
    const url = new URL(decodeEntities(raw.trim()), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function kindOf(url) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'stream';
  if (/\.(mp4|mkv|avi|mov|webm|m4v)$/.test(path)) return 'video';
  if (/\.(mp3|flac|wav|m4a|aac|ogg|opus)$/.test(path)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(path)) return 'image';
  return 'file';
}

function nameOf(url) {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname;
    return decodeURIComponent(segment);
  } catch {
    return url;
  }
}

// Ranks video/stream candidates first, then audio, documents and archives; images last.
const RANK = { stream: 0, video: 1, audio: 2, file: 3, image: 4 };

function sniffPage(html, pageUrl, { limit = 200 } = {}) {
  const found = new Map();
  const add = (raw, source, label = '') => {
    const url = absolute(raw, pageUrl);
    if (!url || url === pageUrl || found.has(url)) return;
    const kind = kindOf(url);
    if (source === 'anchor' && !FILE_LINK.test(url)) return;
    found.set(url, { url, kind, name: nameOf(url), label: label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120), source });
  };
  for (const match of html.matchAll(MEDIA_TAG)) add(match[2], 'media');
  for (const match of html.matchAll(META_MEDIA)) add(match[2] || match[3], 'meta');
  // Players embed their config as JSON, where slashes are escaped as "\/".
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  for (const match of unescaped.matchAll(CONTENT_URL)) add(match[1], 'jsonld');
  for (const match of unescaped.matchAll(QUOTED_STREAM)) add(match[1], 'script');
  for (const match of html.matchAll(ANCHOR)) add(match[1], 'anchor', match[2]);
  return [...found.values()]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])
    .slice(0, limit);
}

function pageTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

module.exports = { sniffPage, pageTitle, kindOf };
