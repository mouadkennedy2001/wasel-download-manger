const path = require('node:path');

const CATEGORY_EXTENSIONS = {
  video: ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.ts', '.3gp', '.mpg', '.mpeg'],
  music: ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.alac'],
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.odt', '.ods', '.odp', '.epub', '.csv', '.md'],
  archives: ['.zip', '.rar', '.7z', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.zst', '.iso', '.img', '.cab'],
  images: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.heic', '.bmp', '.tiff', '.ico', '.psd'],
  software: ['.exe', '.msi', '.msix', '.appx', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.aab', '.appimage', '.jar', '.bat']
};

const CATEGORY_FOLDERS = {
  video: 'Video', music: 'Music', documents: 'Documents', archives: 'Compressed',
  images: 'Images', software: 'Programs', other: 'Other'
};

const MIME_EXTENSIONS = {
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar', 'application/x-7z-compressed': '.7z', 'application/gzip': '.gz',
  'application/x-tar': '.tar', 'application/pdf': '.pdf', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt',
  'application/x-msdownload': '.exe', 'application/x-msi': '.msi', 'application/x-ms-installer': '.msi',
  'application/vnd.android.package-archive': '.apk', 'application/x-apple-diskimage': '.dmg',
  'application/x-iso9660-image': '.iso', 'application/json': '.json', 'application/epub+zip': '.epub',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/x-msvideo': '.avi', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/ogg': '.ogg', 'audio/aac': '.aac',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'text/plain': '.txt', 'text/csv': '.csv',
  'text/html': '.html'
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_NAME_LENGTH = 180;

function cleanFileName(value) {
  let cleaned = path.basename(String(value || ''))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    const extension = path.extname(cleaned).slice(0, 16);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }
  return cleaned && !WINDOWS_RESERVED.test(cleaned) && !/^\.+$/.test(cleaned) ? cleaned : 'download';
}

function uniqueName(fileName, reserved) {
  const extension = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  let result = fileName;
  let index = 1;
  while (reserved.has(result.toLowerCase())) {
    result = `${base} (${index})${extension}`;
    index += 1;
  }
  return result;
}

function categoryFor(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.includes(extension)) return category;
  }
  return 'other';
}

// Node exposes header values as latin1; servers commonly send raw UTF-8 bytes, which
// turns Arabic filenames into mojibake unless the bytes are reinterpreted.
function repairLatin1(value) {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? value : decoded;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function percentDecodeBytes(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const hex = value.slice(index + 1, index + 3);
    if (value[index] === '%' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(value[index], 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

function parseContentDisposition(header) {
  if (typeof header !== 'string' || !header) return null;
  const extended = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended) {
    const raw = extended[1].trim().replace(/^"(.*)"$/, '$1');
    const match = raw.match(/^([\w-]+)'[^']*'(.*)$/);
    if (match) {
      const bytes = percentDecodeBytes(match[2]);
      const name = /^utf-?8$/i.test(match[1]) ? bytes.toString('utf8') : bytes.toString('latin1');
      if (name && !name.includes('�')) return name;
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:\\.|[^"\\])*)"/i);
  const plain = header.match(/filename\s*=\s*([^;]+)/i);
  const value = quoted ? quoted[1].replace(/\\(.)/g, '$1') : plain?.[1]?.trim();
  if (!value) return null;
  const repaired = repairLatin1(value);
  return /%[0-9a-f]{2}/i.test(repaired) ? safeDecode(repaired) : repaired;
}

function isAttachment(header) {
  return typeof header === 'string' && /^\s*attachment/i.test(header);
}

function fileNameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const base = path.posix.basename(url.pathname);
    return base ? safeDecode(base) : '';
  } catch {
    return '';
  }
}

function extensionForMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[type] || '';
}

// Picks the most trustworthy name: Content-Disposition, then the final URL, then the
// original URL, adding an extension from the MIME type when the name has none.
function resolveFileName({ disposition, finalUrl, originalUrl, mime }) {
  let name = parseContentDisposition(disposition)
    || fileNameFromUrl(finalUrl)
    || fileNameFromUrl(originalUrl)
    || 'download';
  name = cleanFileName(name);
  if (!path.extname(name)) name += extensionForMime(mime);
  return name;
}

module.exports = {
  CATEGORY_FOLDERS,
  categoryFor,
  cleanFileName,
  extensionForMime,
  fileNameFromUrl,
  isAttachment,
  parseContentDisposition,
  resolveFileName,
  uniqueName
};
