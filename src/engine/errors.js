// Errors carry a stable code plus parameters so every surface (renderer, tray,
// notifications) can translate them instead of showing engine-side strings.
const ERROR_PREFIX = 'WASEL:';

class WaselError extends Error {
  constructor(code, params = {}, message = code) {
    super(`${ERROR_PREFIX}${code}:${JSON.stringify(params)}`);
    this.name = 'WaselError';
    this.code = code;
    this.params = params;
    this.detail = message;
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'ERR_INCOMPLETE', 'ERR_TIMEOUT',
  'ERR_PROXY'
]);
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function isTransient(error) {
  if (!error) return false;
  if (error.code === 'http') return TRANSIENT_HTTP_STATUS.has(error.params?.status);
  return TRANSIENT_NETWORK_CODES.has(error.code) || /socket hang up|aborted/i.test(error.message || '');
}

// Converts any thrown value into the { code, params } shape persisted on a download row.
function describeError(error, context = {}) {
  if (error instanceof WaselError) return { code: error.code, params: error.params };
  switch (error?.code) {
    case 'EACCES':
    case 'EPERM':
      return { code: 'permission', params: { path: context.path || error.path || '' } };
    case 'ENOSPC':
      return { code: 'disk-full', params: { path: context.path || '' } };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'dns', params: { host: error.hostname || context.host || '' } };
    case 'ECONNREFUSED':
      return { code: 'refused', params: { host: context.host || '' } };
    case 'hls-encrypted':
      return { code: 'hls-encrypted', params: {} };
    case 'ERR_TIMEOUT':
    case 'ETIMEDOUT':
      return { code: 'timeout', params: {} };
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { code: 'tls', params: { detail: error.code } };
    default:
      if (TRANSIENT_NETWORK_CODES.has(error?.code) || /socket hang up/i.test(error?.message || '')) {
        return { code: 'network', params: { detail: error.code || 'ECONNRESET' } };
      }
      return { code: 'unknown', params: { detail: error?.message || String(error) } };
  }
}

module.exports = { ERROR_PREFIX, WaselError, describeError, isTransient };
