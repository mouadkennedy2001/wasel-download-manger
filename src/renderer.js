'use strict';

const api = window.wasel;
const Icons = window.WaselIcons;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const CATEGORY_ICONS = {
  video: 'film', music: 'music', documents: 'doc-text', archives: 'archive', software: 'app', images: 'photo', other: 'doc'
};
const USER_AGENTS = {
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15'
};
const ACTIVE = new Set(['downloading', 'queued', 'verifying']);
const RING = 2 * Math.PI * 10;
const HISTORY = 120;

const state = {
  info: {},
  downloads: [],
  settings: {},
  stats: { speed: 0, active: 0, queued: 0, completed: 0, failed: 0 },
  locale: { locale: 'ar', direction: 'rtl' },
  t: (key) => key,
  filter: 'all',
  category: null,
  query: '',
  sort: { key: 'createdAt', dir: -1 },
  selected: new Set(),
  anchorId: null,
  focusId: null,
  inspectorOpen: readPreference('inspectorOpen', false),
  speedHistory: [],
  itemHistory: new Map(),
  update: { status: 'idle' },
  add: null,
  numberFormat: new Intl.NumberFormat('en', { maximumFractionDigits: 1 }),
  windowFocused: true
};

const rows = new Map();
let toastSeq = 0;

function t(key, params) {
  return state.t(key, params);
}

function readPreference(key, fallback) {
  try {
    const value = localStorage.getItem(`wasel.${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(`wasel.${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; private storage failures are harmless.
  }
}

/* ---------- Localisation ---------- */

async function loadLocale(code) {
  const locale = await api.getLanguage(code);
  const english = code === 'eng' ? null : await api.getLanguage('eng');
  state.locale = locale;
  state.t = window.WaselI18n.createTranslator({ ...locale, fallback: english?.messages });
  state.numberFormat = new Intl.NumberFormat(locale.locale, { maximumFractionDigits: 1, numberingSystem: 'latn' });
  document.documentElement.lang = locale.locale;
  document.documentElement.dir = locale.direction;
  applyStaticText();
  buildDayPicker();
  rows.clear();
  $('#list').replaceChildren();
  render();
}

function applyStaticText() {
  for (const element of $$('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of $$('[data-i18n-placeholder]')) element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of $$('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  for (const element of $$('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
}

function errorKey(code, params = {}) {
  if (code === 'http') {
    const exact = `error.http-${params.status}`;
    if (t(exact) !== exact) return exact;
    if (params.status >= 500) return 'error.http-5xx';
  }
  const key = `error.${code}`;
  return t(key) === key ? 'error.unknown' : key;
}

function errorText(error) {
  if (!error) return '';
  if (error.code) return t(errorKey(error.code, error.params), { detail: error.code, ...error.params });
  const match = String(error.message || error).match(/WASEL:([\w-]+):(\{.*\})/);
  if (match) {
    let params = {};
    try {
      params = JSON.parse(match[2]);
    } catch {
      params = {};
    }
    return t(errorKey(match[1], params), { detail: match[1], ...params });
  }
  return t('error.unknown', { detail: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
}

/* ---------- Formatting ---------- */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(state.locale.locale, { maximumFractionDigits: digits, minimumFractionDigits: index >= 2 ? Math.min(1, digits) : 0, numberingSystem: 'latn' }).format(value)} ${units[index]}`;
}

function formatSpeed(bytes) {
  return `${formatBytes(bytes)}/s`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  seconds = Math.ceil(seconds);
  if (seconds < 60) return t('time.seconds', { count: seconds });
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return minutes < 10 && rest ? `${t('time.minutes', { count: minutes })} ${t('time.seconds', { count: rest })}` : t('time.minutes', { count: minutes });
  }
  const hours = Math.floor(seconds / 3600);
  return `${t('time.hours', { count: hours })} ${t('time.minutes', { count: Math.floor((seconds % 3600) / 60) })}`;
}

function dayBucket(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return 'older';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const diff = (start - date) / 86400000;
  if (date >= start) return 'today';
  if (diff <= 1) return 'yesterday';
  if (diff <= 7) return 'week';
  return 'older';
}

function formatDate(iso, { withTime = true } = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  const bucket = dayBucket(iso);
  const time = new Intl.DateTimeFormat(state.locale.locale, { hour: 'numeric', minute: '2-digit', numberingSystem: 'latn' }).format(date);
  if (bucket === 'today') return withTime ? `${t('date.today')} ${time}` : t('date.today');
  if (bucket === 'yesterday') return withTime ? `${t('date.yesterday')} ${time}` : t('date.yesterday');
  const day = new Intl.DateTimeFormat(state.locale.locale, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', numberingSystem: 'latn' }).format(date);
  return withTime ? `${day} ${time}` : day;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function percentOf(item) {
  if (item.status === 'completed') return 100;
  if (!item.totalBytes) return 0;
  return Math.max(0, Math.min(100, (item.receivedBytes / item.totalBytes) * 100));
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

function tileMarkup(item, large = false) {
  const category = item.category || 'other';
  const extension = extensionOf(item.fileName);
  return `${Icons.markup(CATEGORY_ICONS[category] || 'doc')}${extension ? `<span class="ext">${escapeHtml(extension.slice(0, 4))}</span>` : ''}`;
}

function tileClass(item, large = false) {
  return `file-tile kind-${item.category || 'other'}${large ? ' file-tile-lg' : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/* ---------- Filtering & grouping ---------- */

function matchesFilter(item, filter = state.filter, category = state.category) {
  if (category) return item.category === category;
  switch (filter) {
    case 'active': return item.status === 'downloading' || item.status === 'verifying';
    case 'queued': return item.status === 'queued' || item.status === 'paused';
    case 'completed': return item.status === 'completed';
    case 'failed': return item.status === 'error';
    default: return true;
  }
}

function visibleItems() {
  const query = state.query.toLocaleLowerCase();
  const items = state.downloads.filter((item) => matchesFilter(item)
    && (!query || `${item.fileName} ${item.url} ${hostOf(item.url)}`.toLocaleLowerCase().includes(query)));
  const { key, dir } = state.sort;
  const value = (item) => {
    switch (key) {
      case 'fileName': return item.fileName.toLocaleLowerCase();
      case 'totalBytes': return item.totalBytes || 0;
      case 'progress': return percentOf(item);
      case 'status': return ['downloading', 'verifying', 'queued', 'paused', 'error', 'cancelled', 'completed'].indexOf(item.status);
      default: return Date.parse(item.completedAt || item.createdAt) || 0;
    }
  };
  return items.sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === 'string') return left.localeCompare(right, state.locale.locale) * dir;
    return (left - right) * dir;
  });
}

function buildEntries(items) {
  const grouped = state.sort.key === 'createdAt' && !state.query && ['all', 'completed'].includes(state.filter) && !state.category;
  if (!grouped) return items.map((item) => ({ type: 'item', key: item.id, item }));
  const entries = [];
  const pending = items.filter((item) => item.status !== 'completed');
  const done = items.filter((item) => item.status === 'completed');
  if (pending.length && done.length) entries.push({ type: 'header', key: 'h-progress', label: t('group.inProgress'), count: pending.length });
  for (const item of pending) entries.push({ type: 'item', key: item.id, item });
  let bucket = null;
  for (const item of done) {
    const current = dayBucket(item.completedAt || item.createdAt);
    if (current !== bucket) {
      bucket = current;
      entries.push({ type: 'header', key: `h-${current}`, label: t(`group.${current}`), count: done.filter((entry) => dayBucket(entry.completedAt || entry.createdAt) === current).length });
    }
    entries.push({ type: 'item', key: item.id, item });
  }
  return entries;
}

/* ---------- List rendering ---------- */

function createRow(id) {
  const element = document.createElement('div');
  element.className = 'row-item';
  element.dataset.id = id;
  element.setAttribute('role', 'option');
  element.tabIndex = -1;
  element.innerHTML = `
    <div class="file-tile"></div>
    <div class="row-main">
      <div class="row-name"><strong dir="auto"></strong><span class="badges"></span></div>
      <div class="row-meta"></div>
      <div class="progress"><span></span></div>
    </div>
    <div class="row-actions">
      <button type="button" class="ring-button" data-row-action="primary">
        <svg class="ring" viewBox="0 0 24 24"><circle class="ring-track" cx="12" cy="12" r="10" fill="none" stroke-width="2"/><circle class="ring-value" cx="12" cy="12" r="10" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
        <span class="glyph"></span>
      </button>
      <button type="button" class="icon-button" data-row-action="menu">${Icons.markup('ellipsis')}</button>
    </div>`;
  return element;
}

function rowMeta(item) {
  const parts = [];
  const sep = '<span class="sep">·</span>';
  const size = item.totalBytes ? formatBytes(item.totalBytes) : '';
  switch (item.status) {
    case 'downloading': {
      if (item.retry) {
        const seconds = Math.max(0, Math.ceil((item.retry.at - Date.now()) / 1000));
        return { html: escapeHtml(t('meta.retrying', { seconds, attempt: item.retry.attempt, max: item.retry.max })), tone: 'warn' };
      }
      parts.push(item.totalBytes
        ? escapeHtml(t('meta.ofTotal', { received: formatBytes(item.receivedBytes), total: size }))
        : escapeHtml(formatBytes(item.receivedBytes)));
      if (item.speed) parts.push(`<bdi>${escapeHtml(formatSpeed(item.speed))}</bdi>`);
      if (item.speed && item.totalBytes) parts.push(escapeHtml(t('meta.left', { time: formatDuration((item.totalBytes - item.receivedBytes) / item.speed) })));
      if (!item.speed && !item.receivedBytes) parts.push(escapeHtml(t('meta.connecting')));
      break;
    }
    case 'verifying':
      parts.push(escapeHtml(t('status.verifying')));
      break;
    case 'queued':
      parts.push(escapeHtml(t('status.queued')));
      if (size) parts.push(escapeHtml(size));
      break;
    case 'paused':
      parts.push(escapeHtml(t('status.paused')));
      if (item.totalBytes) parts.push(escapeHtml(t('meta.ofTotal', { received: formatBytes(item.receivedBytes), total: size })));
      else if (item.receivedBytes) parts.push(escapeHtml(formatBytes(item.receivedBytes)));
      break;
    case 'cancelled':
      parts.push(escapeHtml(t('status.cancelled')));
      break;
    case 'error':
      return { html: escapeHtml(errorText(item.error) || t('status.error')), tone: 'error' };
    case 'completed':
      if (size) parts.push(escapeHtml(size));
      if (hostOf(item.url)) parts.push(`<bdi>${escapeHtml(hostOf(item.url))}</bdi>`);
      parts.push(escapeHtml(formatDate(item.completedAt || item.createdAt)));
      break;
    default:
      parts.push(escapeHtml(item.status));
  }
  return { html: parts.join(sep), tone: '' };
}

function badgesFor(item) {
  const badges = [];
  if (item.checksum?.ok === true) badges.push(`<span class="badge badge-ok">${Icons.markup('shield')}${escapeHtml(t('badge.verified'))}</span>`);
  if (item.checksum?.ok === false) badges.push(`<span class="badge badge-warn">${Icons.markup('alert')}${escapeHtml(t('badge.mismatch'))}</span>`);
  if (item.hasCookies && item.status !== 'completed') badges.push(`<span class="badge" title="${escapeHtml(t('badge.sessionTitle'))}">${Icons.markup('lock')}</span>`);
  return badges.join('');
}

function updateRow(element, item) {
  const meta = rowMeta(item);
  const percent = percentOf(item);
  const signature = [item.status, item.fileName, item.category, meta.html, Math.round(percent * 10), item.retry?.attempt, badgesFor(item).length, state.selected.has(item.id)].join('|');
  if (element._signature === signature) return;
  element._signature = signature;
  element.className = `row-item status-${item.status}${state.selected.has(item.id) ? ' selected' : ''}`;
  element.setAttribute('aria-selected', String(state.selected.has(item.id)));
  const tile = element.children[0];
  const tileKey = `${item.category}|${extensionOf(item.fileName)}`;
  if (tile._key !== tileKey) {
    tile._key = tileKey;
    tile.className = tileClass(item);
    tile.innerHTML = tileMarkup(item);
  }
  const name = $('.row-name strong', element);
  if (name.textContent !== item.fileName) {
    name.textContent = item.fileName;
    name.title = item.fileName;
  }
  $('.badges', element).innerHTML = badgesFor(item);
  const metaElement = $('.row-meta', element);
  metaElement.innerHTML = meta.html;
  metaElement.className = `row-meta${meta.tone ? ` ${meta.tone}` : ''}`;
  const progress = $('.progress', element);
  const showProgress = ['downloading', 'paused', 'queued', 'verifying'].includes(item.status) && (item.totalBytes > 0 || item.status === 'downloading');
  progress.hidden = !showProgress;
  progress.classList.toggle('indeterminate', item.status === 'downloading' && !item.totalBytes || item.status === 'verifying');
  progress.firstElementChild.style.width = `${percent}%`;

  const button = $('[data-row-action="primary"]', element);
  const ring = $('.ring', button);
  const glyph = $('.glyph', button);
  let glyphName;
  let title;
  if (ACTIVE.has(item.status)) {
    glyphName = item.status === 'verifying' ? 'hash' : 'pause';
    title = t('action.pause');
    ring.style.display = '';
    $('.ring-value', ring).style.strokeDashoffset = String(RING * (1 - percent / 100));
    button.classList.remove('idle');
  } else {
    ring.style.display = 'none';
    button.classList.add('idle');
    if (item.status === 'completed') {
      glyphName = 'folder-search';
      title = t('action.showInFolder');
    } else {
      glyphName = 'retry';
      title = item.status === 'error' ? t('action.retry') : t('action.resume');
    }
  }
  if (glyph._name !== glyphName) {
    glyph._name = glyphName;
    glyph.innerHTML = Icons.markup(glyphName, 'glyph-icon');
  }
  button.title = title;
  button.setAttribute('aria-label', title);
  button.classList.add('persistent');
  $('[data-row-action="menu"]', element).title = t('action.more');
}

function createHeader(entry) {
  const element = document.createElement('div');
  element.className = 'section-header';
  element.dataset.key = entry.key;
  return element;
}

function renderList() {
  const list = $('#list');
  const items = visibleItems();
  const entries = buildEntries(items);
  const keep = new Set();
  const ordered = [];
  for (const entry of entries) {
    keep.add(entry.key);
    let element = rows.get(entry.key);
    if (!element) {
      element = entry.type === 'header' ? createHeader(entry) : createRow(entry.key);
      rows.set(entry.key, element);
    }
    if (entry.type === 'header') {
      const html = `${escapeHtml(entry.label)} <span>${entry.count}</span>`;
      if (element.innerHTML !== html) element.innerHTML = html;
    } else {
      updateRow(element, entry.item);
    }
    ordered.push(element);
  }
  for (const [key, element] of rows) {
    if (!keep.has(key)) {
      element.remove();
      rows.delete(key);
    }
  }
  let cursor = list.firstElementChild;
  for (const element of ordered) {
    if (element !== cursor) list.insertBefore(element, cursor);
    else cursor = cursor.nextElementSibling;
  }
  const empty = !items.length;
  $('#emptyState').hidden = !empty;
  if (empty) renderEmpty();
  for (const id of [...state.selected]) {
    if (!state.downloads.some((item) => item.id === id)) state.selected.delete(id);
  }
}

function renderEmpty() {
  const key = state.query ? 'search' : state.category ? 'category' : state.filter;
  $('#emptyTitle').textContent = t(`empty.${key}.title`, { query: state.query });
  $('#emptyBody').textContent = t(`empty.${key}.body`, { query: state.query });
  $('.empty-actions').hidden = key !== 'all';
  $('.empty-tips').hidden = key !== 'all' || state.downloads.length > 0;
}

function renderSidebar() {
  const counts = { all: state.downloads.length, active: 0, queued: 0, completed: 0, failed: 0 };
  for (const item of state.downloads) {
    for (const filter of ['active', 'queued', 'completed', 'failed']) if (matchesFilter(item, filter, null)) counts[filter] += 1;
    counts[item.category] = (counts[item.category] || 0) + 1;
  }
  for (const element of $$('[data-count]')) {
    const value = counts[element.dataset.count] || 0;
    element.textContent = value ? String(value) : '';
  }
  for (const element of $$('.nav-item')) {
    element.classList.toggle('selected', state.category ? element.dataset.category === state.category : element.dataset.filter === state.filter && !element.dataset.category);
  }
  $('#speedValue').textContent = formatSpeed(state.stats.speed);
  const meta = [];
  if (state.stats.active) meta.push(t('speed.active', { count: state.stats.active }));
  if (state.stats.queued) meta.push(t('speed.queued', { count: state.stats.queued }));
  $('#speedMeta').textContent = meta.length ? meta.join(' · ') : t('speed.idle');
  const limit = state.settings.speedLimit || 0;
  const turbo = Boolean(state.settings.turbo);
  $('#turboChip').classList.toggle('on', turbo);
  $('.speed-card').classList.toggle('turbo', turbo);
  $('#limitChip').hidden = turbo;
  $('#limitChip').classList.toggle('on', limit > 0);
  $('#limitLabel').textContent = limit ? formatSpeed(limit) : t('speed.unlimited');
  drawSpeedGraph();
}

function renderToolbar() {
  const title = state.category ? t(`category.${state.category}`) : t(`filter.${state.filter}`);
  $('#viewTitle').textContent = title;
  const items = visibleItems();
  const total = items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  $('#viewSubtitle').textContent = items.length
    ? `${t('count.items', { count: items.length })}${total ? ` · ${formatBytes(total)}` : ''}`
    : '';
  document.title = state.stats.active ? `${formatSpeed(state.stats.speed)} — ${t('app.name')}` : t('app.name');
  $('#inspectorToggle').classList.toggle('active', state.inspectorOpen);
  const anyActive = state.downloads.some((item) => ACTIVE.has(item.status));
  const anyResumable = state.downloads.some((item) => ['paused', 'error'].includes(item.status));
  $('[data-command="pause-all"]').disabled = !anyActive;
  $('[data-command="resume-all"]').disabled = !anyResumable;
}

function renderSelectionBar() {
  const count = state.selected.size;
  $('#selectionBar').hidden = count < 2;
  if (count >= 2) $('#selectionCount').textContent = t('count.selected', { count });
}

function render() {
  renderList();
  renderSidebar();
  renderToolbar();
  renderSelectionBar();
  renderInspector();
}

/* ---------- Graphs ---------- */

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#0071e3';
}

function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!hex) return color;
  const value = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawSparkline(canvas, values) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  const accent = cssColor('--accent');
  const max = Math.max(64 * 1024, ...values) * 1.15;
  const step = width / (HISTORY - 1);
  const rtl = document.documentElement.dir === 'rtl';
  const x = (index) => {
    const position = width - (values.length - 1 - index) * step;
    return rtl ? width - position : position;
  };
  const y = (value) => height - 2 - (value / max) * (height - 6);
  context.strokeStyle = cssColor('--separator');
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height - 0.5);
  context.lineTo(width, height - 0.5);
  context.stroke();
  if (values.length < 2) return;
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, withAlpha(accent, 0.3));
  gradient.addColorStop(1, withAlpha(accent, 0));
  context.beginPath();
  context.moveTo(x(0), height);
  values.forEach((value, index) => context.lineTo(x(index), y(value)));
  context.lineTo(x(values.length - 1), height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
  context.beginPath();
  values.forEach((value, index) => (index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value))));
  context.strokeStyle = accent;
  context.lineWidth = 1.6;
  context.lineJoin = 'round';
  context.stroke();
}

function drawSpeedGraph() {
  drawSparkline($('#speedGraph'), state.speedHistory);
}

function drawSegments(canvas, item) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  const accent = cssColor('--accent');
  const rtl = document.documentElement.dir === 'rtl';
  const radius = 5;
  context.save();
  context.beginPath();
  context.roundRect(0, 0, width, height, radius);
  context.clip();
  context.fillStyle = cssColor('--track');
  context.fillRect(0, 0, width, height);
  const paint = (from, to, color) => {
    const left = rtl ? width - to : from;
    context.fillStyle = color;
    context.fillRect(left, 0, Math.max(0, to - from), height);
  };
  if (item.status === 'completed') {
    paint(0, width, accent);
  } else if (item.segments?.length && item.totalBytes) {
    for (const [start, end, done, active] of item.segments) {
      const from = (start / item.totalBytes) * width;
      const to = ((end + 1) / item.totalBytes) * width;
      const filled = from + ((done / (end - start + 1)) * (to - from));
      paint(from, filled, accent);
      if (active && filled < to) paint(Math.max(from, filled - 2), filled, '#ffffff');
      context.fillStyle = cssColor('--window');
      context.fillRect(rtl ? width - to : to - 1, 0, 1, height);
    }
  } else if (item.totalBytes) {
    paint(0, (item.receivedBytes / item.totalBytes) * width, accent);
  }
  context.restore();
}

/* ---------- Inspector ---------- */

function inspectorItem() {
  const id = state.focusId && state.selected.has(state.focusId) ? state.focusId : [...state.selected].at(-1);
  return state.downloads.find((item) => item.id === id) || null;
}

function infoRow(label, value, { html = false, mono = false } = {}) {
  if (value === '' || value === null || value === undefined) return '';
  return `<div><dt>${escapeHtml(label)}</dt><dd${mono ? ' class="mono"' : ''}>${html ? value : escapeHtml(value)}</dd></div>`;
}

function renderInspector() {
  const panel = $('#inspector');
  panel.hidden = !state.inspectorOpen;
  if (!state.inspectorOpen) return;
  const item = inspectorItem();
  $('#inspectorEmpty').hidden = Boolean(item);
  $('#inspectorContent').hidden = !item;
  if (!item) return;

  const tile = $('#inspectorTile');
  const tileKey = `${item.id}|${item.category}|${item.fileName}`;
  if (tile._key !== tileKey) {
    tile._key = tileKey;
    tile.className = tileClass(item, true);
    tile.innerHTML = tileMarkup(item, true);
  }
  $('#inspectorName').textContent = item.fileName;
  $('#inspectorKind').textContent = [t(`category.${item.category || 'other'}`), item.totalBytes ? formatBytes(item.totalBytes) : ''].filter(Boolean).join(' · ');
  const percent = percentOf(item);
  $('#inspectorBar').style.width = `${percent}%`;
  $('#inspectorBar').parentElement.className = `progress status-${item.status}`;
  $('#inspectorPercent').textContent = `${state.numberFormat.format(Math.floor(percent))}%`;
  $('#inspectorRate').textContent = item.status === 'downloading' && item.speed ? formatSpeed(item.speed) : '';

  const segments = item.segments || [];
  const showSegments = ['downloading', 'paused', 'queued'].includes(item.status) || item.status === 'completed';
  $('#segmentsGroup').hidden = !showSegments;
  if (showSegments) {
    const activeCount = segments.filter((segment) => segment[3]).length;
    $('#segmentsCount').textContent = segments.length ? t('inspector.segments', { active: activeCount, count: segments.length }) : '';
    drawSegments($('#segmentMap'), item);
    const history = state.itemHistory.get(item.id) || [];
    $('#itemGraph').hidden = !history.length || item.status === 'completed';
    if (history.length) drawSparkline($('#itemGraph'), history);
  }

  const remaining = item.speed && item.totalBytes ? formatDuration((item.totalBytes - item.receivedBytes) / item.speed) : '';
  const checksum = item.checksum
    ? `${item.checksum.algorithm.toUpperCase()} — ${item.checksum.ok === true ? t('badge.verified') : item.checksum.ok === false ? t('badge.mismatch') : t('inspector.pending')}`
    : '';
  $('#infoList').innerHTML = [
    infoRow(t('inspector.status'), item.status === 'error' ? errorText(item.error) : t(`status.${item.status}`)),
    infoRow(t('inspector.size'), item.totalBytes ? formatBytes(item.totalBytes) : t('inspector.unknown')),
    item.status !== 'completed' ? infoRow(t('inspector.downloaded'), formatBytes(item.receivedBytes)) : '',
    item.status === 'downloading' ? infoRow(t('inspector.speed'), formatSpeed(item.speed || 0)) : '',
    remaining ? infoRow(t('inspector.timeLeft'), remaining) : '',
    infoRow(t('inspector.resumable'), item.resumable === true ? t('common.yes') : item.resumable === false ? t('common.no') : t('inspector.unknown')),
    infoRow(t('inspector.source'), hostOf(item.finalUrl || item.url)),
    item.referer ? infoRow(t('inspector.referer'), item.referer, { mono: true }) : '',
    infoRow(t('inspector.added'), formatDate(item.createdAt)),
    item.completedAt ? infoRow(t('inspector.completed'), formatDate(item.completedAt)) : '',
    infoRow(t('inspector.savedTo'), `<a data-inspector-link="show" dir="ltr">${escapeHtml(item.savePath)}</a>`, { html: true }),
    infoRow(t('inspector.link'), `<a data-inspector-link="copy" dir="ltr" title="${escapeHtml(t('action.copyLink'))}">${escapeHtml(item.url)}</a>`, { html: true }),
    checksum ? infoRow(t('inspector.checksum'), checksum) : '',
    item.hash ? infoRow('SHA-256', item.hash, { mono: true }) : ''
  ].join('');

  const completed = item.status === 'completed';
  $('[data-inspector="open"]').hidden = !completed;
  $('[data-inspector="hash"]').hidden = !completed;
  $('[data-inspector="restart"]').hidden = ACTIVE.has(item.status);
}

/* ---------- Selection ---------- */

function selectOnly(id) {
  state.selected = new Set([id]);
  state.anchorId = id;
  state.focusId = id;
}

function handleRowClick(event, id) {
  const ids = visibleItems().map((item) => item.id);
  if (event.shiftKey && state.anchorId && ids.includes(state.anchorId)) {
    const [from, to] = [ids.indexOf(state.anchorId), ids.indexOf(id)].sort((a, b) => a - b);
    if (!event.ctrlKey && !event.metaKey) state.selected.clear();
    for (const entry of ids.slice(from, to + 1)) state.selected.add(entry);
    state.focusId = id;
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.anchorId = id;
    state.focusId = id;
  } else {
    selectOnly(id);
  }
  render();
}

function moveSelection(delta, extend) {
  const ids = visibleItems().map((item) => item.id);
  if (!ids.length) return;
  const current = ids.indexOf(state.focusId);
  const next = ids[Math.max(0, Math.min(ids.length - 1, current === -1 ? 0 : current + delta))];
  if (extend) {
    state.selected.add(next);
    state.focusId = next;
  } else {
    selectOnly(next);
  }
  render();
  rows.get(next)?.scrollIntoView({ block: 'nearest' });
}

function selectedItems() {
  return state.downloads.filter((item) => state.selected.has(item.id));
}

/* ---------- Actions ---------- */

async function call(action, success) {
  try {
    const result = await action();
    if (success) toast(typeof success === 'function' ? success(result) : success, { type: 'success' });
    return result;
  } catch (error) {
    toast(errorText(error), { type: 'error' });
    return undefined;
  }
}

async function primaryAction(item) {
  if (ACTIVE.has(item.status)) await call(() => api.pause(item.id));
  else if (item.status === 'completed') await call(() => api.showFile(item.id));
  else await call(() => api.resume(item.id));
}

async function removeItems(items, { askFiles = true } = {}) {
  if (!items.length) return;
  const anyCompleted = items.some((item) => item.status === 'completed');
  const result = await confirmDialog({
    title: items.length > 1 ? t('remove.titleMany', { count: items.length }) : t('remove.title', { name: items[0].fileName }),
    message: t('remove.message'),
    confirm: t('action.remove'),
    destructive: true,
    checkbox: askFiles && anyCompleted ? t('remove.alsoFiles') : null
  });
  if (!result.confirmed) return;
  for (const item of items) await call(() => api.remove(item.id, result.checked));
  for (const item of items) state.selected.delete(item.id);
  render();
}

async function runCommand(command) {
  const items = selectedItems();
  switch (command) {
    case 'add': openAddSheet(); break;
    case 'paste': await pasteFromClipboard(); break;
    case 'settings': openSettings(); break;
    case 'resume-all': await call(() => api.resumeAll()); break;
    case 'pause-all': await call(() => api.pauseAll()); break;
    case 'resume-selected': for (const item of items) if (['paused', 'error', 'cancelled'].includes(item.status)) await call(() => api.resume(item.id)); break;
    case 'pause-selected': for (const item of items) if (ACTIVE.has(item.status)) await call(() => api.pause(item.id)); break;
    case 'remove-selected': await removeItems(items); break;
    case 'clear-selection': state.selected.clear(); render(); break;
    case 'toggle-inspector':
      state.inspectorOpen = !state.inspectorOpen;
      writePreference('inspectorOpen', state.inspectorOpen);
      render();
      break;
    case 'toggle-sidebar': $('#app').classList.toggle('sidebar-hidden'); break;
    case 'export': await call(() => api.exportDownloads(), (done) => (done ? t('toast.exported') : null)); break;
    case 'import': {
      const count = await call(() => api.importDownloads());
      if (count) toast(t('toast.imported', { count }), { type: 'success' });
      break;
    }
    case 'clear-completed': {
      if (!state.downloads.some((item) => item.status === 'completed')) return;
      const result = await confirmDialog({ title: t('clear.title'), message: t('clear.message'), confirm: t('action.clearCompleted') });
      if (result.confirmed) await call(() => api.clearCompleted());
      break;
    }
    default: break;
  }
}

function itemMenu(item) {
  const entries = [];
  const completed = item.status === 'completed';
  if (completed) {
    entries.push({ label: t('action.open'), icon: 'external', run: () => call(() => api.openFile(item.id)) });
    entries.push({ label: t('action.showInFolder'), icon: 'folder-search', run: () => call(() => api.showFile(item.id)) });
  }
  if (ACTIVE.has(item.status)) entries.push({ label: t('action.pause'), icon: 'pause', run: () => call(() => api.pause(item.id)) });
  if (['paused', 'error', 'cancelled'].includes(item.status)) entries.push({ label: item.status === 'error' ? t('action.retry') : t('action.resume'), icon: 'play', run: () => call(() => api.resume(item.id)) });
  if (!completed && item.status !== 'cancelled') entries.push({ label: t('action.cancel'), icon: 'stop', run: () => call(() => api.cancel(item.id)) });
  entries.push('-');
  entries.push({ label: t('action.copyLink'), icon: 'link', run: () => call(() => api.copyText(item.url), t('toast.linkCopied')) });
  if (completed) entries.push({ label: t('action.copyPath'), icon: 'copy', run: () => call(() => api.copyText(item.savePath), t('toast.pathCopied')) });
  entries.push({ label: t('action.openSource'), icon: 'globe', run: () => call(() => api.openExternal(item.referer || item.url)) });
  if (!ACTIVE.has(item.status)) entries.push({ label: t('action.redownload'), icon: 'retry', run: () => call(() => api.restart(item.id)) });
  entries.push({ label: t('inspector.title'), icon: 'info', run: () => { state.inspectorOpen = true; writePreference('inspectorOpen', true); render(); } });
  entries.push('-');
  entries.push({ label: t('action.remove'), icon: 'trash', danger: true, run: () => removeItems([item]) });
  return entries;
}

function showMenu(entries, { x, y, anchor } = {}) {
  const menu = $('#menu');
  menu.innerHTML = '';
  for (const entry of entries) {
    if (entry === '-') {
      menu.append(document.createElement('hr'));
      continue;
    }
    if (entry.heading) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';
      heading.textContent = entry.heading;
      menu.append(heading);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.className = `${entry.danger ? 'danger' : ''}${entry.checked ? ' checked' : ''}`;
    button.disabled = Boolean(entry.disabled);
    button.innerHTML = `${entry.icon ? Icons.markup(entry.icon) : ''}<span>${escapeHtml(entry.label)}</span>${entry.shortcut ? `<kbd>${escapeHtml(entry.shortcut)}</kbd>` : ''}`;
    button.addEventListener('click', () => {
      hideMenu();
      entry.run?.();
    });
    menu.append(button);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    left = document.documentElement.dir === 'rtl' ? box.left : box.right - rect.width;
    top = box.bottom + 4;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function hideMenu() {
  $('#menu').hidden = true;
}

/* ---------- Toasts & dialogs ---------- */

function toast(message, { type = 'info', action, duration = 3600 } = {}) {
  if (!message) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  const icon = type === 'error' ? 'alert' : type === 'success' ? 'check-circle' : 'info';
  element.innerHTML = `${Icons.markup(icon)}<span></span>`;
  element.querySelector('span').textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-primary';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.run();
      dismiss();
    });
    element.append(button);
  }
  const stack = $('#toasts');
  stack.append(element);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  const id = ++toastSeq;
  element.dataset.id = String(id);
  const timer = setTimeout(dismiss, action ? duration * 2 : duration);
  function dismiss() {
    clearTimeout(timer);
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 260);
  }
}

let activeSheet = null;
let alertResolver = null;

function openSheet(id) {
  hideMenu();
  if (activeSheet && activeSheet.id !== id) closeSheet({ immediate: true });
  const sheet = document.getElementById(id);
  $('#scrim').hidden = false;
  sheet.hidden = false;
  sheet.classList.remove('closing');
  activeSheet = sheet;
  return sheet;
}

function closeSheet({ immediate = false } = {}) {
  if (!activeSheet) return;
  const sheet = activeSheet;
  activeSheet = null;
  if (sheet.id === 'alertSheet' && alertResolver) {
    alertResolver({ confirmed: false, checked: false });
    alertResolver = null;
  }
  if (sheet.id === 'addSheet') state.add = null;
  const finish = () => {
    sheet.hidden = true;
    sheet.classList.remove('closing');
    if (!activeSheet) $('#scrim').hidden = true;
  };
  if (immediate) finish();
  else {
    sheet.classList.add('closing');
    setTimeout(finish, 180);
  }
}

function confirmDialog({ title, message, confirm, destructive = false, checkbox = null }) {
  const sheet = openSheet('alertSheet');
  sheet.classList.toggle('destructive', destructive);
  $('#alertTitle').textContent = title;
  $('#alertMessage').textContent = message || '';
  $('#alertConfirm').textContent = confirm;
  $('#alertCheckRow').hidden = !checkbox;
  $('#alertCheck').checked = false;
  $('#alertCheckLabel').textContent = checkbox || '';
  setTimeout(() => $('#alertConfirm').focus(), 50);
  return new Promise((resolve) => { alertResolver = resolve; });
}

/* ---------- Add sheet ---------- */

// Expands numbered series such as file[01-12].jpg or photo[a-e].png.
function expandPattern(url) {
  const match = /\[(\d+)-(\d+)\]|\[([a-z])-([a-z])\]/i.exec(url);
  if (!match) return [url];
  const results = [];
  if (match[1] !== undefined) {
    const width = match[1].length;
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (Math.abs(to - from) > 2000) return [url];
    const step = from <= to ? 1 : -1;
    for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
      results.push(url.replace(match[0], String(value).padStart(width, '0')));
    }
  } else {
    const from = match[3].charCodeAt(0);
    const to = match[4].charCodeAt(0);
    for (let code = Math.min(from, to); code <= Math.max(from, to); code += 1) results.push(url.replace(match[0], String.fromCharCode(code)));
  }
  return results.flatMap(expandPattern);
}

function parseUrls(text) {
  const urls = [];
  for (const raw of String(text || '').split(/[\r\n\s]+/)) {
    const value = raw.trim().replace(/^<|>$/g, '');
    if (!value) continue;
    const normalized = /^www\./i.test(value) ? `https://${value}` : value;
    for (const url of expandPattern(normalized)) {
      try {
        const parsed = new URL(url);
        if (['http:', 'https:'].includes(parsed.protocol)) urls.push(parsed.href);
        else urls.push({ invalid: url });
      } catch {
        urls.push({ invalid: url });
      }
    }
  }
  const seen = new Set();
  return urls.filter((entry) => {
    const key = typeof entry === 'string' ? entry : entry.invalid;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2000);
}

function openAddSheet(prefill = {}) {
  openSheet('addSheet');
  state.add = {
    folder: state.settings.outputFolder,
    connections: 0,
    cookies: prefill.cookies || [],
    userAgent: prefill.userAgent || '',
    source: prefill.source || 'manual',
    fileName: prefill.fileName || '',
    totalBytes: prefill.totalBytes || 0,
    mime: prefill.mime || '',
    probes: new Map(),
    probeTimer: null
  };
  $('#addForm').reset();
  $('#urlInput').value = (prefill.urls || []).join('\n');
  $('#fileNameInput').value = prefill.fileName || '';
  $('#refererInput').value = prefill.referer || '';
  $('#userAgentInput').value = '';
  $('#cookieInput').value = '';
  $('#cookieInput').placeholder = state.add.cookies.length ? t('add.cookiesFromBrowser', { count: state.add.cookies.length }) : 'name=value; other=value';
  $('#startImmediately').checked = true;
  $('#addError').textContent = '';
  $('#advancedOptions').open = false;
  setSegmented($('#connectionsControl'), '0');
  const subtitle = $('#addSource');
  if (state.add.source === 'browser') {
    subtitle.className = 'sheet-subtitle from-browser';
    subtitle.innerHTML = `${Icons.markup('lock')}<span></span>`;
    subtitle.querySelector('span').textContent = state.add.cookies.length ? t('add.fromBrowserSession') : t('add.fromBrowser');
  } else {
    subtitle.className = 'sheet-subtitle';
    subtitle.textContent = state.add.source === 'clipboard' ? t('add.fromClipboard') : t('add.subtitle');
  }
  $('#addFolder').textContent = state.add.folder;
  updateAddPreview();
  setTimeout(() => {
    const input = $('#urlInput');
    if (input.value) $('#addSubmit').focus();
    else input.focus();
  }, 60);
}

function updateAddPreview() {
  if (!state.add) return;
  const entries = parseUrls($('#urlInput').value);
  const urls = entries.filter((entry) => typeof entry === 'string');
  const single = urls.length <= 1;
  $('#fileNameInput').disabled = !single;
  $('#fileNameLabel').style.opacity = single ? '' : '0.4';
  const list = $('#probeList');
  list.hidden = !entries.length;
  const submitLabel = $('#addSubmit span');
  submitLabel.textContent = urls.length > 1 ? t('add.downloadCount', { count: urls.length }) : t('action.download');
  $('#addSubmit').disabled = !urls.length;

  const visible = entries.slice(0, 60);
  list.innerHTML = visible.map((entry) => {
    if (typeof entry !== 'string') {
      return `<li><div class="file-tile kind-other">${Icons.markup('alert')}</div><div><div class="probe-name" dir="ltr">${escapeHtml(entry.invalid)}</div><div class="probe-meta error">${escapeHtml(t('error.invalid-url', {}))}</div></div><span></span></li>`;
    }
    const probe = state.add.probes.get(entry);
    const guessName = decodeURIComponent((entry.split('?')[0].split('/').pop() || hostOf(entry))) || entry;
    const name = probe?.info?.fileName || (single && $('#fileNameInput').value) || guessName;
    const category = probe?.info?.category || 'other';
    const duplicate = state.downloads.some((item) => item.url === entry);
    let meta = `<div class="probe-meta" dir="ltr">${escapeHtml(hostOf(entry))}</div>`;
    let size = probe?.status === 'loading' ? '<span class="spinner"></span>' : '';
    if (probe?.status === 'error') meta = `<div class="probe-meta error">${escapeHtml(probe.error)}</div>`;
    if (probe?.status === 'done') {
      const notes = [hostOf(entry), probe.info.resumable ? t('add.resumable') : t('add.notResumable')];
      meta = `<div class="probe-meta${duplicate ? ' warn' : ''}">${escapeHtml(duplicate ? t('add.duplicate') : notes.join(' · '))}</div>`;
      size = probe.info.totalBytes ? escapeHtml(formatBytes(probe.info.totalBytes)) : '';
    } else if (duplicate) {
      meta = `<div class="probe-meta warn">${escapeHtml(t('add.duplicate'))}</div>`;
    }
    return `<li><div class="file-tile kind-${category}">${Icons.markup(CATEGORY_ICONS[category] || 'doc')}</div><div><div class="probe-name">${escapeHtml(name)}</div>${meta}</div><span class="probe-size">${size}</span></li>`;
  }).join('') + (entries.length > visible.length ? `<li><span></span><div class="probe-meta">${escapeHtml(t('add.more', { count: entries.length - visible.length }))}</div><span></span></li>` : '');

  renderPageCandidates(urls, list);

  if (single && urls.length === 1 && !$('#fileNameInput').value) {
    const info = state.add.probes.get(urls[0])?.info;
    $('#fileNameInput').placeholder = info?.fileName || t('add.fileNameAuto');
  }
  clearTimeout(state.add.probeTimer);
  state.add.probeTimer = setTimeout(() => probeUrls(urls.slice(0, 12)), 450);
}

const CANDIDATE_CATEGORY = { stream: 'video', video: 'video', audio: 'music', image: 'images' };

// When the single link is a web page, list what was found on it and let the user pick.
// The main video or stream is picked by default.
function renderPageCandidates(urls, list) {
  const pageUrl = urls.length === 1 ? urls[0] : null;
  const probe = pageUrl ? state.add.probes.get(pageUrl) : null;
  if (!probe || probe.status !== 'done' || !probe.info.page) {
    state.add.page = null;
    return;
  }
  const candidates = probe.info.candidates || [];
  if (state.add.page?.url !== pageUrl) {
    const media = candidates.find((candidate) => ['stream', 'video', 'audio'].includes(candidate.kind));
    state.add.page = { url: pageUrl, picked: new Set(media ? [media.url] : []) };
  }
  const picked = state.add.page.picked;
  const heading = candidates.length
    ? t('add.pageFound', { count: candidates.length, title: probe.info.title || hostOf(pageUrl) })
    : t('add.pageEmpty');
  list.innerHTML = `<li class="probe-heading">${escapeHtml(heading)}</li>` + candidates.slice(0, 80).map((candidate) => {
    const category = CANDIDATE_CATEGORY[candidate.kind] || 'other';
    const meta = [t(`add.kind.${candidate.kind}`), candidate.label, hostOf(candidate.url)].filter(Boolean).join(' · ');
    return `<li class="candidate"><input type="checkbox" data-candidate="${escapeHtml(candidate.url)}"${picked.has(candidate.url) ? ' checked' : ''}>
      <div class="file-tile kind-${category}">${Icons.markup(CATEGORY_ICONS[category] || 'doc')}</div>
      <div><div class="probe-name" dir="auto">${escapeHtml(candidate.name)}</div><div class="probe-meta">${escapeHtml(meta)}</div></div><span></span></li>`;
  }).join('');
  const count = picked.size;
  $('#addSubmit span').textContent = count > 1 ? t('add.downloadCount', { count }) : t('action.download');
}

async function probeUrls(urls) {
  if (!state.add) return;
  const add = state.add;
  const referer = $('#refererInput').value.trim();
  const cookieHeader = $('#cookieInput').value.trim();
  await Promise.all(urls.map(async (url) => {
    if (add.probes.has(url)) return;
    add.probes.set(url, { status: 'loading' });
    updateAddPreviewSoon();
    try {
      const info = await api.probe({ url, referer, cookies: add.cookies, cookieHeader });
      add.probes.set(url, { status: 'done', info });
    } catch (error) {
      add.probes.set(url, { status: 'error', error: errorText(error) });
    }
    if (state.add === add) updateAddPreviewSoon();
  }));
}

let previewFrame = 0;
function updateAddPreviewSoon() {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    if (!state.add) return;
    const timer = state.add.probeTimer;
    updateAddPreview();
    clearTimeout(state.add.probeTimer);
    state.add.probeTimer = timer;
  });
}

async function submitAdd(event) {
  event.preventDefault();
  if (!state.add) return;
  const add = state.add;
  const entries = parseUrls($('#urlInput').value);
  let urls = entries.filter((entry) => typeof entry === 'string');
  const error = $('#addError');
  error.textContent = '';
  // A page link with picked items downloads those items, with the page as referrer.
  const page = add.page && urls.length === 1 && add.page.url === urls[0] && add.page.picked.size ? add.page : null;
  if (page) urls = [...page.picked];
  if (!urls.length) {
    error.textContent = t('error.empty-url');
    return;
  }
  const checksum = $('#checksumInput').value.trim();
  if (checksum && !/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i.test(checksum)) {
    error.textContent = t('error.invalid-checksum');
    return;
  }
  const button = $('#addSubmit');
  button.disabled = true;
  let added = 0;
  try {
    for (const url of urls) {
      await api.add({
        url,
        fileName: urls.length === 1 && !page ? $('#fileNameInput').value.trim() : '',
        folder: add.folder !== state.settings.outputFolder ? add.folder : undefined,
        startImmediately: $('#startImmediately').checked,
        referer: $('#refererInput').value.trim() || (page ? page.url : ''),
        cookies: add.cookies,
        cookieHeader: $('#cookieInput').value.trim(),
        userAgent: $('#userAgentInput').value.trim() || add.userAgent,
        connections: add.connections || undefined,
        checksum: checksum ? { expected: checksum } : undefined,
        totalBytes: urls.length === 1 ? add.totalBytes : 0,
        mime: urls.length === 1 ? add.mime : '',
        source: add.source === 'browser' ? 'browser' : urls.length > 1 ? 'batch' : add.source === 'clipboard' ? 'clipboard' : 'manual'
      });
      added += 1;
    }
    closeSheet();
    if (!state.category && !['all', 'active', 'queued'].includes(state.filter)) {
      state.filter = 'all';
    }
    toast(t('toast.added', { count: added }), { type: 'success' });
  } catch (reason) {
    error.textContent = errorText(reason);
  } finally {
    button.disabled = false;
  }
}

async function pasteFromClipboard() {
  const text = await call(() => api.readClipboard());
  const urls = parseUrls(text || '').filter((entry) => typeof entry === 'string');
  openAddSheet({ urls, source: urls.length ? 'clipboard' : 'manual' });
}

/* ---------- Settings ---------- */

function setSegmented(control, value) {
  for (const button of $$('button', control)) button.classList.toggle('active', button.dataset.value === String(value));
}

function openSettings(pane = 'general') {
  openSheet('settingsSheet');
  showPane(pane);
  renderSettings();
}

function showPane(pane) {
  for (const tab of $$('.settings-tab')) tab.classList.toggle('active', tab.dataset.pane === pane);
  for (const section of $$('.pane')) section.hidden = section.dataset.pane !== pane;
  if (pane === 'updates' && ['idle', 'none', 'error'].includes(state.update.status) && !state.update.checkedAt) api.checkForUpdates().catch(() => {});
}

function renderSettings() {
  const settings = state.settings;
  $('#languageSelect').value = settings.language;
  for (const button of $$('[data-theme-option]')) button.classList.toggle('active', button.dataset.themeOption === settings.theme);
  for (const button of $$('[data-accent-option]')) button.classList.toggle('active', button.dataset.accentOption === settings.accent);
  for (const input of $$('[data-setting]')) {
    const value = settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = String(value ?? '');
  }
  for (const control of $$('[data-setting-segmented]')) setSegmented(control, settings[control.dataset.settingSegmented]);
  $('#settingsFolder').textContent = settings.outputFolder;

  const limit = settings.speedLimit || 0;
  $('#speedLimitToggle').checked = limit > 0;
  $('#speedLimitRow').hidden = limit === 0;
  const remembered = limit || readPreference('lastSpeedLimit', 1024 * 1024);
  const unit = remembered >= 1024 * 1024 && remembered % (1024 * 1024) === 0 ? 1024 * 1024 : 1024;
  $('#speedLimitUnit').value = String(unit);
  $('#speedLimitValue').value = String(Math.round(remembered / unit));

  setSegmented($('#proxyMode'), settings.proxy?.mode || 'system');
  $('#proxyRow').hidden = settings.proxy?.mode !== 'manual';
  if (document.activeElement !== $('#proxyUrl')) $('#proxyUrl').value = settings.proxy?.url || '';

  const preset = Object.entries(USER_AGENTS).find(([, value]) => value === settings.userAgent)?.[0];
  $('#userAgentPreset').value = !settings.userAgent ? '' : preset || 'custom';
  $('#userAgentRow').hidden = $('#userAgentPreset').value !== 'custom';
  if (document.activeElement !== $('#userAgentCustom')) $('#userAgentCustom').value = preset ? '' : settings.userAgent || '';

  const schedule = settings.schedule || { enabled: false, start: '02:00', stop: '', days: [] };
  $('#scheduleEnabled').checked = schedule.enabled;
  if (document.activeElement !== $('#scheduleStart')) $('#scheduleStart').value = schedule.start;
  if (document.activeElement !== $('#scheduleStop')) $('#scheduleStop').value = schedule.stop;
  for (const button of $$('#dayPicker button')) button.classList.toggle('active', schedule.days.includes(Number(button.dataset.day)));
  $('#scheduleNext').textContent = schedule.enabled ? nextScheduleText(schedule) : t('schedule.off');

  const port = state.info.bridgePort;
  $('#bridgeStatus').classList.toggle('ok', Boolean(port));
  $('#bridgeText').textContent = port ? t('bridge.listening', { port }) : t('bridge.unavailable');
  renderExtensionPath();
  $('#aboutVersion').textContent = `${t('about.version', { version: state.info.version || '' })}`;
  renderUpdate();
}

function nextScheduleText(schedule) {
  const [hours, minutes] = schedule.start.split(':').map(Number);
  const now = new Date();
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate > now && schedule.days.includes(candidate.getDay())) {
      return t('schedule.next', { when: formatDate(candidate.toISOString()) });
    }
  }
  return t('schedule.noDays');
}

function buildDayPicker() {
  const picker = $('#dayPicker');
  const order = state.locale.direction === 'rtl' ? [6, 0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 0];
  const format = new Intl.DateTimeFormat(state.locale.locale, { weekday: 'short' });
  const base = new Date(2024, 0, 7);
  picker.innerHTML = order.map((day) => {
    const date = new Date(base);
    date.setDate(base.getDate() + day);
    return `<button type="button" data-day="${day}">${escapeHtml(format.format(date))}</button>`;
  }).join('');
}

function renderExtensionPath() {
  const browser = $('#browserTabs .active')?.dataset.value || 'chromium';
  $('#stepsChromium').hidden = browser !== 'chromium';
  $('#stepsFirefox').hidden = browser !== 'firefox';
  $('#extensionPath').textContent = state.info.extensionPaths?.[browser] || '';
}

async function saveSettings(changes) {
  const settings = await call(() => api.updateSettings(changes));
  if (settings) {
    const languageChanged = settings.language !== state.settings.language;
    state.settings = settings;
    applyAppearance();
    if (languageChanged) await loadLocale(settings.language);
    renderSettings();
    render();
  } else {
    renderSettings();
  }
}

function applyAppearance() {
  document.documentElement.dataset.theme = state.settings.theme || 'system';
  document.documentElement.dataset.accent = state.settings.accent || 'blue';
}

function speedLimitFromInputs() {
  const value = Math.max(1, Math.round(Number($('#speedLimitValue').value) || 1));
  return value * Number($('#speedLimitUnit').value);
}

/* ---------- Updates ---------- */

function renderUpdate() {
  const update = state.update;
  const title = $('#updateTitle');
  const detail = $('#updateDetail');
  detail.className = '';
  $('#updateProgress').hidden = true;
  $('#downloadUpdate').hidden = true;
  $('#installUpdate').hidden = true;
  $('#checkUpdates').hidden = false;
  $('#checkUpdates').disabled = false;
  switch (update.status) {
    case 'checking':
      title.textContent = t('updates.checking');
      detail.textContent = t('updates.current', { version: state.info.version });
      $('#checkUpdates').disabled = true;
      break;
    case 'available':
      title.textContent = t('updates.available', { version: update.version });
      detail.textContent = t('updates.current', { version: state.info.version });
      $('#downloadUpdate').hidden = false;
      break;
    case 'downloading':
      title.textContent = t('updates.downloading', { version: update.version || '' });
      detail.textContent = `${update.progress || 0}%`;
      $('#updateProgress').hidden = false;
      $('#updateBar').style.width = `${update.progress || 0}%`;
      $('#checkUpdates').disabled = true;
      break;
    case 'ready':
      title.textContent = t('updates.ready', { version: update.version });
      detail.textContent = t('updates.readyHint');
      $('#installUpdate').hidden = false;
      $('#checkUpdates').hidden = true;
      break;
    case 'none':
      title.textContent = t('updates.upToDate');
      detail.textContent = t('updates.current', { version: state.info.version });
      break;
    case 'error':
      title.textContent = t('updates.failed');
      detail.textContent = t(`updates.error.${update.error || 'unknown'}`);
      detail.className = 'error';
      break;
    case 'unsupported':
      title.textContent = t('updates.dev');
      detail.textContent = t('updates.current', { version: state.info.version });
      $('#checkUpdates').disabled = true;
      break;
    default:
      title.textContent = t('updates.current', { version: state.info.version });
      detail.textContent = t('updates.idle');
  }
  const notes = $('#releaseNotes');
  notes.hidden = !update.notes || !['available', 'downloading', 'ready'].includes(update.status);
  notes.textContent = update.notes || '';
  $('#updateBadge').hidden = !['available', 'ready'].includes(update.status);
}

/* ---------- Events ---------- */

function bindEvents() {
  for (const button of $$('[data-command]')) {
    button.addEventListener('click', () => runCommand(button.dataset.command));
  }
  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => {
      state.filter = item.dataset.filter || 'all';
      state.category = item.dataset.category || null;
      state.selected.clear();
      $('#list').scrollTop = 0;
      render();
    });
  }

  const list = $('#list');
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.row-item');
    if (!row) {
      if (event.target === list) {
        state.selected.clear();
        render();
      }
      return;
    }
    const item = state.downloads.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    const action = event.target.closest('[data-row-action]')?.dataset.rowAction;
    if (action === 'primary') {
      primaryAction(item);
      return;
    }
    if (action === 'menu') {
      if (!state.selected.has(item.id)) selectOnly(item.id);
      render();
      showMenu(itemMenu(item), { anchor: event.target.closest('button') });
      return;
    }
    handleRowClick(event, item.id);
  });
  list.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.row-item');
    if (!row || event.target.closest('button')) return;
    const item = state.downloads.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    if (item.status === 'completed') call(() => api.openFile(item.id));
    else {
      state.inspectorOpen = true;
      writePreference('inspectorOpen', true);
      render();
    }
  });
  list.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.row-item');
    if (!row) return;
    event.preventDefault();
    const item = state.downloads.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    if (!state.selected.has(item.id)) selectOnly(item.id);
    render();
    if (state.selected.size > 1) {
      showMenu([
        { heading: t('count.selected', { count: state.selected.size }) },
        { label: t('action.resume'), icon: 'play', run: () => runCommand('resume-selected') },
        { label: t('action.pause'), icon: 'pause', run: () => runCommand('pause-selected') },
        { label: t('action.copyLinks'), icon: 'link', run: () => call(() => api.copyText(selectedItems().map((entry) => entry.url).join('\n')), t('toast.linkCopied')) },
        '-',
        { label: t('action.remove'), icon: 'trash', danger: true, run: () => runCommand('remove-selected') }
      ], { x: event.clientX, y: event.clientY });
    } else {
      showMenu(itemMenu(item), { x: event.clientX, y: event.clientY });
    }
  });

  $('#sortButton').addEventListener('click', (event) => {
    const option = (key, label) => ({
      label, checked: state.sort.key === key, run: () => {
        state.sort = { key, dir: state.sort.key === key ? state.sort.dir : (key === 'fileName' ? 1 : -1) };
        writePreference('sort', state.sort);
        render();
      }
    });
    showMenu([
      { heading: t('sort.title') },
      option('createdAt', t('sort.date')),
      option('fileName', t('sort.name')),
      option('totalBytes', t('sort.size')),
      option('progress', t('sort.progress')),
      option('status', t('sort.status')),
      '-',
      { label: t('sort.ascending'), checked: state.sort.dir === 1, run: () => { state.sort.dir = 1; writePreference('sort', state.sort); render(); } },
      { label: t('sort.descending'), checked: state.sort.dir === -1, run: () => { state.sort.dir = -1; writePreference('sort', state.sort); render(); } }
    ], { anchor: event.currentTarget });
  });

  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.target.value.trim();
    render();
  });

  $('#inspectorBody').addEventListener('click', (event) => {
    const item = inspectorItem();
    if (!item) return;
    const link = event.target.closest('[data-inspector-link]')?.dataset.inspectorLink;
    if (link === 'show') call(() => api.showFile(item.id));
    if (link === 'copy') call(() => api.copyText(item.url), t('toast.linkCopied'));
    const action = event.target.closest('[data-inspector]')?.dataset.inspector;
    if (!action) return;
    if (action === 'open') call(() => api.openFile(item.id));
    if (action === 'show') call(() => api.showFile(item.id));
    if (action === 'copy-url') call(() => api.copyText(item.url), t('toast.linkCopied'));
    if (action === 'restart') call(() => api.restart(item.id));
    if (action === 'remove') removeItems([item]);
    if (action === 'hash') {
      toast(t('toast.hashing'));
      call(() => api.hash(item.id, 'sha256')).then((hash) => {
        if (!hash) return;
        item.hash = hash;
        renderInspector();
        call(() => api.copyText(hash), t('toast.hashCopied'));
      });
    }
  });

  for (const button of $$('[data-window-action]')) {
    button.addEventListener('click', () => api.windowAction(button.dataset.windowAction));
  }
  $('.toolbar').addEventListener('dblclick', (event) => {
    if (!event.target.closest('button, input, label')) api.windowAction('maximize');
  });
  $('.sidebar-top').addEventListener('dblclick', (event) => {
    if (!event.target.closest('button')) api.windowAction('maximize');
  });

  $('#scrim').addEventListener('click', () => {
    if (activeSheet?.id !== 'alertSheet') closeSheet();
  });
  for (const button of $$('[data-close-sheet]')) button.addEventListener('click', () => closeSheet());
  $('#alertConfirm').addEventListener('click', () => {
    const resolve = alertResolver;
    alertResolver = null;
    closeSheet();
    resolve?.({ confirmed: true, checked: $('#alertCheck').checked });
  });

  $('#addForm').addEventListener('submit', submitAdd);
  $('#urlInput').addEventListener('input', updateAddPreview);
  $('#probeList').addEventListener('change', (event) => {
    const box = event.target.closest('[data-candidate]');
    if (!box || !state.add?.page) return;
    if (box.checked) state.add.page.picked.add(box.dataset.candidate);
    else state.add.page.picked.delete(box.dataset.candidate);
    updateAddPreviewSoon();
  });
  $('#fileNameInput').addEventListener('input', updateAddPreviewSoon);
  $('#urlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('#addForm').requestSubmit();
  });
  $('#connectionsControl').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !state.add) return;
    state.add.connections = Number(button.dataset.value);
    setSegmented($('#connectionsControl'), button.dataset.value);
  });
  $('#addBrowse').addEventListener('click', async () => {
    if (!state.add) return;
    const folder = await call(() => api.chooseFolder(state.add.folder));
    if (folder && state.add) {
      state.add.folder = folder;
      $('#addFolder').textContent = folder;
    }
  });

  // Settings
  for (const tab of $$('.settings-tab')) tab.addEventListener('click', () => showPane(tab.dataset.pane));
  $('#languageSelect').addEventListener('change', (event) => saveSettings({ language: event.target.value }));
  for (const button of $$('[data-theme-option]')) button.addEventListener('click', () => saveSettings({ theme: button.dataset.themeOption }));
  for (const button of $$('[data-accent-option]')) button.addEventListener('click', () => saveSettings({ accent: button.dataset.accentOption }));
  for (const input of $$('[data-setting]')) {
    input.addEventListener('change', () => {
      const key = input.dataset.setting;
      const value = input.type === 'checkbox' ? input.checked : input.hasAttribute('data-number') ? Number(input.value) : input.value;
      saveSettings({ [key]: value });
    });
  }
  for (const control of $$('[data-setting-segmented]')) {
    control.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) saveSettings({ [control.dataset.settingSegmented]: Number(button.dataset.value) });
    });
  }
  $('#changeOutputFolder').addEventListener('click', async () => {
    const folder = await call(() => api.chooseFolder());
    if (folder) {
      const settings = await call(() => api.setOutputFolder(folder));
      if (settings) {
        state.settings = settings;
        renderSettings();
      }
    }
  });
  $('#openOutputFolder').addEventListener('click', () => call(() => api.openFolder()));
  $('#speedLimitToggle').addEventListener('change', (event) => {
    saveSettings({ speedLimit: event.target.checked ? speedLimitFromInputs() : 0 });
  });
  const applySpeed = () => {
    const limit = speedLimitFromInputs();
    writePreference('lastSpeedLimit', limit);
    if ($('#speedLimitToggle').checked) saveSettings({ speedLimit: limit });
  };
  $('#speedLimitValue').addEventListener('change', applySpeed);
  $('#speedLimitUnit').addEventListener('change', applySpeed);
  $('#turboChip').addEventListener('click', async () => {
    const enable = !state.settings.turbo;
    await saveSettings({ turbo: enable });
    toast(enable ? t('toast.turboOn') : t('toast.turboOff'), { type: enable ? 'success' : 'info' });
  });
  $('#limitChip').addEventListener('click', () => {
    const current = state.settings.speedLimit || 0;
    if (current) writePreference('lastSpeedLimit', current);
    saveSettings({ speedLimit: current ? 0 : readPreference('lastSpeedLimit', 1024 * 1024) });
    toast(current ? t('toast.limitOff') : t('toast.limitOn', { speed: formatSpeed(readPreference('lastSpeedLimit', 1024 * 1024)) }));
  });
  $('#proxyMode').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const mode = button.dataset.value;
    if (mode === 'manual' && !$('#proxyUrl').value.trim()) {
      setSegmented($('#proxyMode'), 'manual');
      $('#proxyRow').hidden = false;
      $('#proxyUrl').focus();
      return;
    }
    saveSettings({ proxy: { mode, url: $('#proxyUrl').value.trim() } });
  });
  $('#proxyUrl').addEventListener('change', () => saveSettings({ proxy: { mode: 'manual', url: $('#proxyUrl').value.trim() } }));
  $('#userAgentPreset').addEventListener('change', (event) => {
    const value = event.target.value;
    if (value === 'custom') {
      $('#userAgentRow').hidden = false;
      $('#userAgentCustom').focus();
      return;
    }
    saveSettings({ userAgent: USER_AGENTS[value] || '' });
  });
  $('#userAgentCustom').addEventListener('change', (event) => saveSettings({ userAgent: event.target.value.trim() }));
  const saveSchedule = () => {
    const days = $$('#dayPicker button.active').map((button) => Number(button.dataset.day));
    saveSettings({ schedule: { enabled: $('#scheduleEnabled').checked, start: $('#scheduleStart').value || '02:00', stop: $('#scheduleStop').value || '', days } });
  };
  $('#scheduleEnabled').addEventListener('change', saveSchedule);
  $('#scheduleStart').addEventListener('change', saveSchedule);
  $('#scheduleStop').addEventListener('change', saveSchedule);
  $('#dayPicker').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    button.classList.toggle('active');
    saveSchedule();
  });
  $('#browserTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    setSegmented($('#browserTabs'), button.dataset.value);
    renderExtensionPath();
  });
  $('#copyExtensionPath').addEventListener('click', () => call(() => api.copyText($('#extensionPath').textContent), t('toast.pathCopied')));
  $('#openExtensionPath').addEventListener('click', () => call(() => api.openFolder($('#extensionPath').textContent)));
  $('#checkUpdates').addEventListener('click', () => call(() => api.checkForUpdates()));
  $('#downloadUpdate').addEventListener('click', () => call(() => api.downloadUpdate()));
  $('#installUpdate').addEventListener('click', () => call(() => api.installUpdate()));
  for (const button of $$('[data-link]')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const target = button.dataset.link === 'assistant' ? 'https://github.com/riadfgg'
        : button.dataset.link === 'website' ? state.info.website
        : button.dataset.link === 'issues' ? `${state.info.repository}/issues` : state.info.repository;
      call(() => api.openExternal(target));
    });
  }

  // Global keyboard handling
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const typing = event.target.closest('input, textarea, select, [contenteditable]');
    if (event.key === 'Escape') {
      if (!$('#menu').hidden) hideMenu();
      else if (activeSheet) closeSheet();
      else if (state.query) {
        $('#searchInput').value = '';
        state.query = '';
        render();
      } else if (state.selected.size) {
        state.selected.clear();
        render();
      }
      return;
    }
    if (activeSheet) return;
    if (mod && key === 'n') { event.preventDefault(); runCommand('add'); return; }
    if (mod && key === ',') { event.preventDefault(); openSettings(); return; }
    if (mod && key === 'f') { event.preventDefault(); $('#searchInput').focus(); return; }
    if (mod && key === 'i') { event.preventDefault(); runCommand('toggle-inspector'); return; }
    if (mod && event.shiftKey && key === 'p') { event.preventDefault(); runCommand('pause-all'); return; }
    if (mod && event.shiftKey && key === 'r') { event.preventDefault(); runCommand('resume-all'); return; }
    if (typing) return;
    if (mod && key === 'a') {
      event.preventDefault();
      state.selected = new Set(visibleItems().map((item) => item.id));
      render();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
    } else if (event.key === ' ') {
      event.preventDefault();
      const items = selectedItems();
      if (items.some((item) => ACTIVE.has(item.status))) runCommand('pause-selected');
      else runCommand('resume-selected');
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && mod)) {
      runCommand('remove-selected');
    } else if (event.key === 'Enter') {
      const item = inspectorItem();
      if (item?.status === 'completed') call(() => api.openFile(item.id));
    } else if (mod && key === 'c' && state.selected.size) {
      call(() => api.copyText(selectedItems().map((item) => item.url).join('\n')), t('toast.linkCopied'));
    }
  });

  document.addEventListener('paste', (event) => {
    if (activeSheet || event.target.closest('input, textarea')) return;
    const urls = parseUrls(event.clipboardData.getData('text')).filter((entry) => typeof entry === 'string');
    if (urls.length) {
      event.preventDefault();
      openAddSheet({ urls, source: 'clipboard' });
    }
  });

  document.addEventListener('mousedown', (event) => {
    if (!$('#menu').hidden && !event.target.closest('#menu')) hideMenu();
  });
  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', () => {
    hideMenu();
    drawSpeedGraph();
    renderInspector();
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (![...event.dataTransfer.types].some((type) => type === 'text/uri-list' || type === 'text/plain')) return;
    dragDepth += 1;
    $('#dropOverlay').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').hidden = true;
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const text = [event.dataTransfer.getData('text/uri-list'), event.dataTransfer.getData('text/plain')].filter(Boolean).join('\n');
    const urls = parseUrls(text.split('\n').filter((line) => !line.startsWith('#')).join('\n')).filter((entry) => typeof entry === 'string');
    if (!urls.length) return;
    let added = 0;
    for (const url of urls) {
      if (await call(() => api.add({ url, startImmediately: true, source: urls.length > 1 ? 'batch' : 'manual' }))) added += 1;
    }
    if (added) toast(t('toast.added', { count: added }), { type: 'success' });
  });
}

/* ---------- Live state ---------- */

function applyState(next) {
  state.downloads = next.downloads;
  state.stats = next.stats || state.stats;
  const settingsChanged = JSON.stringify(next.settings) !== JSON.stringify(state.settings);
  state.settings = next.settings;
  state.speedHistory.push(state.stats.speed || 0);
  if (state.speedHistory.length > HISTORY) state.speedHistory.shift();
  const live = new Set();
  for (const item of state.downloads) {
    if (item.status !== 'downloading') continue;
    live.add(item.id);
    const history = state.itemHistory.get(item.id) || [];
    history.push(item.speed || 0);
    if (history.length > HISTORY) history.shift();
    state.itemHistory.set(item.id, history);
  }
  for (const id of state.itemHistory.keys()) {
    if (!live.has(id) && !state.downloads.some((item) => item.id === id && item.status === 'paused')) state.itemHistory.delete(id);
  }
  if (settingsChanged) {
    applyAppearance();
    if (activeSheet?.id === 'settingsSheet') renderSettings();
  }
  render();
}

async function init() {
  Icons.hydrate();
  const saved = readPreference('sort', null);
  if (saved?.key) state.sort = saved;
  const [info, initial, languages, update] = await Promise.all([api.info(), api.getState(), api.listLanguages(), api.getUpdateState()]);
  state.info = info;
  state.update = update || state.update;
  document.documentElement.classList.toggle('material', Boolean(info.material));
  $('#languageSelect').innerHTML = languages.map((language) => `<option value="${language.code}">${escapeHtml(language.name)}</option>`).join('');
  state.settings = initial.settings;
  state.downloads = initial.downloads;
  state.stats = initial.stats;
  applyAppearance();
  bindEvents();
  await loadLocale(initial.settings.language);

  api.onChange(applyState);
  api.onIncoming((payload) => openAddSheet(payload));
  api.onUpdateState((update) => {
    state.update = update;
    renderUpdate();
    if (update.status === 'ready') {
      toast(t('updates.ready', { version: update.version }), { action: { label: t('updates.install'), run: () => api.installUpdate() } });
    }
  });
  api.onNotice((notice) => toast(t(notice.key, notice.params), { type: notice.type }));
  api.onOpenSettings((pane) => openSettings(pane));
  api.onWindowFocus((focused) => {
    state.windowFocused = focused;
    document.body.classList.toggle('window-blurred', !focused);
  });
  setInterval(() => {
    if (state.downloads.some((item) => item.retry)) renderList();
  }, 1000);
  await api.ready();
}

init().catch((error) => {
  console.error(error);
  toast(errorText(error), { type: 'error', duration: 10000 });
});
