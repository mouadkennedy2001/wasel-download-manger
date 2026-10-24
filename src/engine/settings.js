const { isSupportedLanguage } = require('../languages');
const { WaselError } = require('./errors');

const ACCENTS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'];
const WHEN_DONE = ['none', 'quit', 'sleep', 'shutdown'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function oneOf(values) {
  return (value) => (values.includes(value) ? value : undefined);
}

function integer(min, max) {
  return (value) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
  };
}

function boolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function shortText(max) {
  return (value) => (typeof value === 'string' && value.length <= max ? value.trim() : undefined);
}

function proxy(value) {
  if (!value || typeof value !== 'object') return undefined;
  const mode = oneOf(['system', 'none', 'manual'])(value.mode);
  if (!mode) return undefined;
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if (mode === 'manual') {
    try {
      const parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return undefined;
    } catch {
      return undefined;
    }
  }
  return { mode, url };
}

function schedule(value) {
  if (!value || typeof value !== 'object') return undefined;
  const days = Array.isArray(value.days) ? [...new Set(value.days.map(Number))] : [];
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return undefined;
  if (typeof value.enabled !== 'boolean') return undefined;
  if (!TIME.test(value.start || '')) return undefined;
  if (value.stop && !TIME.test(value.stop)) return undefined;
  return { enabled: value.enabled, start: value.start, stop: value.stop || '', days: days.sort() };
}

const SCHEMA = {
  theme: { default: 'system', validate: oneOf(['system', 'light', 'dark']) },
  accent: { default: 'blue', validate: oneOf(ACCENTS) },
  language: { default: 'ara', validate: (value) => (isSupportedLanguage(value) ? value : undefined) },
  maxActiveDownloads: { default: 3, validate: integer(1, 10) },
  connectionsPerDownload: { default: 8, validate: integer(1, 32) },
  // Turbo: 32 connections per file and no speed limit, to use the full line speed.
  turbo: { default: false, validate: boolean },
  startWithWindows: { default: false, validate: boolean },
  categoryFolders: { default: false, validate: boolean },
  speedLimit: { default: 0, validate: integer(0, 10 * 1024 * 1024 * 1024) },
  retryCount: { default: 5, validate: integer(0, 20) },
  userAgent: { default: '', validate: shortText(512) },
  proxy: { default: { mode: 'system', url: '' }, validate: proxy },
  notifyOnComplete: { default: true, validate: boolean },
  preventSleep: { default: true, validate: boolean },
  askBeforeCapture: { default: true, validate: boolean },
  clipboardMonitor: { default: false, validate: boolean },
  autoUpdate: { default: true, validate: boolean },
  schedule: { default: { enabled: false, start: '02:00', stop: '', days: [0, 1, 2, 3, 4, 5, 6] }, validate: schedule },
  whenDone: { default: 'none', validate: oneOf(WHEN_DONE) }
};

function defaultSettings() {
  return Object.fromEntries(Object.entries(SCHEMA).map(([key, spec]) => [key, structuredClone(spec.default)]));
}

// Strict path used by the UI: unknown keys are ignored, invalid values are rejected.
function applySettings(current, changes) {
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    if (value === undefined || !SCHEMA[key]) continue;
    const normalized = SCHEMA[key].validate(value);
    if (normalized === undefined) throw new WaselError('invalid-setting', { key });
    next[key] = normalized;
  }
  return next;
}

// Lenient path used for files written by older versions: bad values fall back to defaults.
function restoreSettings(stored) {
  const settings = defaultSettings();
  if (!stored || typeof stored !== 'object') return settings;
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const normalized = stored[key] === undefined ? undefined : spec.validate(stored[key]);
    if (normalized !== undefined) settings[key] = normalized;
  }
  if (stored.theme === 'light' || stored.theme === 'dark') settings.theme = stored.theme;
  return settings;
}

module.exports = { ACCENTS, SCHEMA, applySettings, defaultSettings, restoreSettings };
