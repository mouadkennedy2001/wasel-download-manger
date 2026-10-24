// HLS (m3u8) support: picks the best variant of a master playlist, lists the media
// segments, and decrypts AES-128 segments so the result is one playable .ts file.
const crypto = require('node:crypto');

function isPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

function isHlsUrl(url) {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

function isHlsMime(mime) {
  return /mpegurl/i.test(mime || '');
}

function attributes(line) {
  const result = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

// Returns the highest-bandwidth variant URL, or null when this is already a media playlist.
function bestVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let best = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
    const info = attributes(lines[index]);
    const uri = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
    if (!uri) continue;
    const bandwidth = Number(info.BANDWIDTH || info['AVERAGE-BANDWIDTH'] || 0);
    if (!best || bandwidth > best.bandwidth) best = { url: new URL(uri, baseUrl).href, bandwidth, resolution: info.RESOLUTION || '' };
  }
  return best;
}

function mediaSegments(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const segments = [];
  let sequence = 0;
  let key = null;
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const info = attributes(line.slice(11));
      key = info.METHOD === 'NONE' ? null : {
        method: info.METHOD,
        uri: info.URI ? new URL(info.URI, baseUrl).href : null,
        iv: info.IV ? Buffer.from(info.IV.replace(/^0x/i, '').padStart(32, '0'), 'hex') : null
      };
    } else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith('#')) {
      const index = sequence + segments.length;
      segments.push({ url: new URL(line, baseUrl).href, duration, key, sequence: index });
      duration = 0;
    }
  }
  if (segments.some((segment) => segment.key && segment.key.method !== 'AES-128')) {
    throw Object.assign(new Error('Unsupported HLS encryption'), { code: 'hls-encrypted' });
  }
  return segments;
}

function sequenceIv(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(Math.floor(sequence / 2 ** 32), 8);
  iv.writeUInt32BE(sequence % 2 ** 32, 12);
  return iv;
}

function decryptSegment(data, keyBytes, segment) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, segment.key.iv || sequenceIv(segment.sequence));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = { bestVariant, decryptSegment, isHlsMime, isHlsUrl, isPlaylist, mediaSegments };
