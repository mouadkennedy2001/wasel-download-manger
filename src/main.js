const {
  app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeTheme, powerSaveBlocker, screen, session, shell
} = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { DownloadManager } = require('./download-manager');
const { UpdateService } = require('./updater');
const { createBridgeServer } = require('./bridge-server');
const { Scheduler } = require('./scheduler');
const { createTranslator } = require('./i18n');
const { SUPPORTED_LANGUAGES, isSupportedLanguage } = require('./languages');

const APP_ID = 'com.zerouki.wasel';
const WEBSITE = 'https://mouadkennedy2001.github.io/wasel-download-manger/';
const REPOSITORY = 'https://github.com/mouadkennedy2001/wasel-download-manger';
const ICON = path.join(__dirname, '..', 'assets', 'wasel.ico');
const CLIPBOARD_LINK = /^https?:\/\/[^\s]+\.(zip|rar|7z|tar|gz|tgz|xz|iso|img|exe|msi|msix|apk|dmg|pkg|deb|rpm|mp4|mkv|avi|mov|webm|m4v|mp3|flac|wav|m4a|aac|ogg|pdf|epub|docx?|xlsx?|pptx?|psd)(\?[^\s]*)?$/i;

let mainWindow = null;
let tray = null;
let manager = null;
let updates = null;
let bridge = null;
let scheduler = null;
let parseDownloadProtocolUrl = null;
let t = (key) => key;
let isQuitting = false;
let rendererReady = false;
let pendingIncoming = [];
let powerBlocker = null;
let lastClipboard = '';
let clipboardTimer = null;
let extensionPaths = { chromium: '', firefox: '' };
let windowStateTimer = null;
const launchHidden = process.argv.includes('--hidden');
const supportsMica = process.platform === 'win32' && !process.env.WASEL_NO_MATERIAL
  && Number(os.release().split('.')[2] || 0) >= 22621;
// Development and screenshot runs use an isolated profile instead of the user's library.
if (process.env.WASEL_USER_DATA) app.setPath('userData', process.env.WASEL_USER_DATA);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Links from the browser, the protocol handler or the clipboard open the add sheet so
// the user always sees and confirms what is about to be downloaded.
function presentIncoming(payload) {
  showMainWindow();
  if (!rendererReady) {
    pendingIncoming.push(payload);
    return;
  }
  send('downloads:incoming', payload);
}

function notify({ title, body, onClick }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

async function loadLocale(code) {
  const language = isSupportedLanguage(code) ? code : 'ara';
  const read = async (name) => JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lang', `${name}.json`), 'utf8'));
  const locale = await read(language);
  const english = language === 'eng' ? null : await read('eng');
  t = createTranslator({ ...locale, fallback: english?.messages });
  updateTrayMenu();
}

function processProtocolUrl(rawUrl) {
  if (!/^wasel:/i.test(rawUrl)) return;
  if (!parseDownloadProtocolUrl) {
    pendingIncoming.push({ protocol: rawUrl });
    return;
  }
  try {
    presentIncoming({ urls: [parseDownloadProtocolUrl(rawUrl)], source: 'protocol' });
  } catch (error) {
    send('app:notice', { key: 'notice.badLink', type: 'error' });
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    processProtocolUrl(url);
  });
  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = commandLine.find((argument) => /^wasel:/i.test(argument));
    showMainWindow();
    if (protocolUrl) processProtocolUrl(protocolUrl);
  });
}

async function readWindowState() {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'window-state.json'), 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea }) =>
      stored.x < workArea.x + workArea.width - 80 && stored.x + stored.width > workArea.x + 80
      && stored.y < workArea.y + workArea.height - 40 && stored.y >= workArea.y - 20);
    return visible ? stored : { width: stored.width, height: stored.height, maximized: stored.maximized };
  } catch {
    return { width: 1180, height: 760 };
  }
}

function saveWindowState() {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    fs.writeFile(path.join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() })).catch(() => {});
  }, 400);
}

const TITLE_BAR_HEIGHT = 52;

function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: supportsMica ? '#00000000' : (dark ? '#1e1e20' : '#ffffff'),
    symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
    height: TITLE_BAR_HEIGHT
  };
}

nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(titleBarColors());
});

async function createWindow() {
  const stored = await readWindowState();
  mainWindow = new BrowserWindow({
    x: stored.x,
    y: stored.y,
    width: Math.max(stored.width || 1180, 820),
    height: Math.max(stored.height || 760, 520),
    minWidth: 820,
    minHeight: 520,
    // Hidden title bar with the native Windows caption buttons (minimize, maximize with
    // Snap Layouts, close) drawn over the top-right corner of the page.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    show: false,
    backgroundColor: supportsMica ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f5f5f7'),
    ...(supportsMica ? { backgroundMaterial: 'mica' } : {}),
    title: 'Wasel',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  if (stored.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => {
    if (!launchHidden || pendingIncoming.length) mainWindow?.show();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    showTrayHintOnce();
  });
  mainWindow.on('maximize', () => { send('window:maximized', true); saveWindowState(); });
  mainWindow.on('unmaximize', () => { send('window:maximized', false); saveWindowState(); });
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('focus', () => send('window:focus', true));
  mainWindow.on('blur', () => send('window:focus', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(path.join(__dirname, 'index.html')).href) event.preventDefault();
  });
  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

async function showTrayHintOnce() {
  const marker = path.join(app.getPath('userData'), 'tray-hint-shown');
  try {
    await fs.access(marker);
  } catch {
    notify({ title: t('main.trayHint.title'), body: t('main.trayHint.body'), onClick: showMainWindow });
    fs.writeFile(marker, '1').catch(() => {});
  }
}

function createTray() {
  tray = new Tray(ICON);
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
}

function updateTrayMenu(state = manager?.getState()) {
  if (!tray || tray.isDestroyed() || !state) return;
  const { active, queued } = state.stats;
  const running = active + queued > 0;
  tray.setToolTip(active
    ? `${t('app.name')} — ${t('main.tray.active', { count: active })} · ${formatSpeed(state.stats.speed)}`
    : t('app.name'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('main.tray.open'), click: showMainWindow },
    { label: t('main.tray.add'), click: () => presentIncoming({ urls: [], source: 'manual' }) },
    { type: 'separator' },
    {
      label: running ? t('main.tray.pauseAll') : t('main.tray.resumeAll'),
      click: () => (running ? manager.pauseAll() : manager.resumeAll()).catch(() => {})
    },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: () => app.quit() }
  ]));
}

function formatSpeed(bytes) {
  if (!bytes) return '0 KB/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

let lastTraySignature = '';
function onDownloadsChanged(state) {
  send('downloads:changed', state);
  const signature = `${state.stats.active}|${state.stats.queued}|${Math.round(state.stats.speed / 51200)}`;
  if (signature !== lastTraySignature) {
    lastTraySignature = signature;
    updateTrayMenu(state);
  }
  updateTaskbar(state);
  updatePowerBlocker(state);
}

function updateTaskbar(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = state.downloads.filter((item) => item.status === 'downloading');
  if (!active.length) {
    mainWindow.setProgressBar(state.stats.queued ? 2 : -1, { mode: state.stats.queued ? 'indeterminate' : 'none' });
    return;
  }
  const sized = active.filter((item) => item.totalBytes > 0);
  if (!sized.length) {
    mainWindow.setProgressBar(2, { mode: 'indeterminate' });
    return;
  }
  const received = sized.reduce((sum, item) => sum + item.receivedBytes, 0);
  const total = sized.reduce((sum, item) => sum + item.totalBytes, 0);
  mainWindow.setProgressBar(Math.min(1, received / total), { mode: 'normal' });
}

function updatePowerBlocker(state) {
  const shouldBlock = state.settings.preventSleep && state.stats.active > 0;
  if (shouldBlock && powerBlocker === null) {
    powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldBlock && powerBlocker !== null) {
    powerSaveBlocker.stop(powerBlocker);
    powerBlocker = null;
  }
}

function onDownloadEvent(event) {
  const settings = manager.getState().settings;
  if (event.type === 'completed' && settings.notifyOnComplete) {
    const body = event.item.checksum?.ok === false ? `${event.item.fileName}\n${t('main.notify.checksumMismatch')}` : event.item.fileName;
    notify({ title: t('main.notify.completed'), body, onClick: () => shell.showItemInFolder(event.item.savePath) });
  } else if (event.type === 'failed' && settings.notifyOnComplete) {
    notify({ title: t('main.notify.failed'), body: event.item.fileName, onClick: showMainWindow });
  } else if (event.type === 'idle' && settings.whenDone !== 'none') {
    runWhenDone(settings.whenDone).catch(() => {});
  }
}

async function runWhenDone(action) {
  await manager.updateSettings({ whenDone: 'none' });
  if (action === 'quit') {
    app.quit();
  } else if (action === 'sleep' && process.platform === 'win32') {
    execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
  } else if (action === 'shutdown' && process.platform === 'win32') {
    execFile('shutdown', ['/s', '/t', '60']);
    notify({
      title: t('main.notify.shutdownTitle'),
      body: t('main.notify.shutdownBody'),
      onClick: () => execFile('shutdown', ['/a'])
    });
  }
}

function setWindowsStartup(enabled) {
  if (process.platform !== 'win32') throw new Error('WASEL:startup-unsupported:{}');
  if (!app.isPackaged) throw new Error('WASEL:startup-dev:{}');
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
}

// Clipboard reads can yield non-strings on some Windows setups (locked clipboard,
// remote sessions); normalizing here keeps the monitor from throwing at startup.
function readClipboardText() {
  try {
    const text = clipboard.readText();
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

function startClipboardMonitor() {
  lastClipboard = readClipboardText();
  clipboardTimer = setInterval(() => {
    if (!manager?.getState().settings.clipboardMonitor) return;
    const text = readClipboardText();
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (text.length > 4096 || /\s/.test(text) || !CLIPBOARD_LINK.test(text)) return;
    if (manager.getState().downloads.some((item) => item.url === text)) return;
    let name = text;
    try {
      name = decodeURIComponent(new URL(text).pathname.split('/').pop()) || text;
    } catch {
      // Keep the raw link as the label.
    }
    notify({
      title: t('main.notify.clipboard'),
      body: name,
      onClick: () => presentIncoming({ urls: [text], source: 'clipboard' })
    });
  }, 1200);
  clipboardTimer.unref();
}

// Unpacked extensions cannot load from inside app.asar, so the bundled extension is
// copied to a stable folder the user can point the browser at. Updates refresh it.
async function prepareExtensionFolders() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension');
  const root = path.join(app.getPath('userData'), 'browser-extension');
  const chromium = path.join(root, 'chromium');
  const firefox = path.join(root, 'firefox');
  const skip = (file) => !/manifest\.firefox\.json$|INSTALL\.md$|tutorial/.test(file);
  try {
    await fs.cp(source, chromium, { recursive: true, force: true, filter: skip });
    await fs.cp(source, firefox, { recursive: true, force: true, filter: skip });
    await fs.copyFile(path.join(source, 'manifest.firefox.json'), path.join(firefox, 'manifest.json'));
    extensionPaths = { chromium, firefox };
  } catch {
    extensionPaths = { chromium: source, firefox: source };
  }
}

async function handleBridgeDownload(payload) {
  const settings = manager.getState().settings;
  if (settings.askBeforeCapture || payload.urls.length > 1 || payload.source === 'page') {
    presentIncoming({ ...payload, source: 'browser' });
    return { queued: false, confirm: true };
  }
  for (const url of payload.urls) {
    await manager.add({
      url,
      fileName: payload.fileName,
      referer: payload.referer,
      cookies: payload.cookies,
      userAgent: payload.userAgent,
      totalBytes: payload.totalBytes,
      mime: payload.mime,
      source: 'browser'
    });
  }
  notify({ title: t('main.notify.captured'), body: payload.fileName || payload.urls[0], onClick: showMainWindow });
  return { queued: true, confirm: false };
}

// Handlers receive only the renderer's arguments. Appending the IPC event made it fill
// any optional parameter the renderer left out (e.g. chooseFolder() got the event as
// its default path); handlers that need the sender use handleWithSender instead.
function handle(channel, listener) {
  ipcMain.handle(channel, (_event, ...args) => listener(...args));
}

function handleWithSender(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => listener(BrowserWindow.fromWebContents(event.sender), ...args));
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    material: supportsMica,
    extensionPaths,
    bridgePort: bridge?.port || null,
    website: WEBSITE,
    repository: REPOSITORY,
    electron: process.versions.electron
  }));
  handle('app:ready', () => {
    rendererReady = true;
    const queued = pendingIncoming;
    pendingIncoming = [];
    for (const entry of queued) {
      if (entry.protocol) processProtocolUrl(entry.protocol);
      else send('downloads:incoming', entry);
    }
  });
  handle('languages:list', async () => Promise.all(SUPPORTED_LANGUAGES.map(async (code) => {
    const locale = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lang', `${code}.json`), 'utf8'));
    return { code, name: locale.name, direction: locale.direction };
  })));
  handle('languages:get', async (code) => {
    if (!isSupportedLanguage(code)) throw new Error('WASEL:invalid-setting:{"key":"language"}');
    return JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lang', `${code}.json`), 'utf8'));
  });
  handleWithSender('window:action', (window, action) => {
    if (!window) return null;
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return window.isMaximized();
    } else if (action === 'close') window.close();
    else if (action === 'quit') app.quit();
    return null;
  });
  handleWithSender('window:is-maximized', (window) => window?.isMaximized() ?? false);
  // The renderer reports the colors under the caption buttons so they blend in.
  handleWithSender('window:overlay', (window, colors) => {
    const hex = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
    if (!window || !hex.test(colors?.color) || !hex.test(colors?.symbolColor)) return false;
    window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_HEIGHT });
    return true;
  });

  handle('updates:get-state', () => updates.state);
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:install', () => {
    const installing = updates.install();
    if (installing) isQuitting = true;
    return installing;
  });

  handle('downloads:get-state', () => manager.getState());
  handle('downloads:add', (input) => manager.add(input));
  handle('downloads:probe', (input) => manager.probe(input));
  handle('downloads:pause', (id) => manager.pause(id));
  handle('downloads:resume', (id) => manager.resume(id));
  handle('downloads:restart', (id) => manager.restart(id));
  handle('downloads:cancel', (id) => manager.cancel(id));
  handle('downloads:remove', (id, deleteFile) => manager.remove(id, { deleteFile: Boolean(deleteFile) }));
  handle('downloads:clear-completed', () => manager.clearCompleted());
  handle('downloads:pause-all', () => manager.pauseAll());
  handle('downloads:resume-all', () => manager.resumeAll());
  handle('downloads:hash', (id, algorithm) => manager.hash(id, algorithm));
  handle('downloads:update-settings', async (changes) => {
    const previous = manager.getState().settings;
    if (typeof changes?.startWithWindows === 'boolean' && changes.startWithWindows !== previous.startWithWindows) {
      setWindowsStartup(changes.startWithWindows);
    }
    const settings = await manager.updateSettings(changes);
    if (settings.theme !== previous.theme) nativeTheme.themeSource = settings.theme;
    if (settings.language !== previous.language) await loadLocale(settings.language);
    return settings;
  });
  handle('downloads:choose-folder', async (defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : manager.getState().settings.outputFolder
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('downloads:set-output-folder', (folder) => manager.setOutputFolder(folder));
  handle('downloads:open-file', async (id) => {
    const item = manager.getDownload(id);
    if (!item || item.status !== 'completed') throw new Error('WASEL:not-completed:{}');
    const error = await shell.openPath(item.savePath);
    if (error) throw new Error(`WASEL:open-failed:${JSON.stringify({ detail: error })}`);
  });
  handle('downloads:show-file', async (id) => {
    const item = manager.getDownload(id);
    if (!item) throw new Error('WASEL:not-found:{}');
    try {
      await fs.access(item.savePath);
      shell.showItemInFolder(item.savePath);
    } catch {
      await shell.openPath(path.dirname(item.savePath));
    }
  });
  handle('downloads:open-folder', async (folder) => {
    const error = await shell.openPath(typeof folder === 'string' && folder ? folder : manager.getState().settings.outputFolder);
    if (error) throw new Error(`WASEL:open-failed:${JSON.stringify({ detail: error })}`);
  });
  handle('app:open-external', async (url) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('WASEL:unsupported-protocol:{}');
    await shell.openExternal(parsed.href);
  });
  handle('app:copy-text', (text) => clipboard.writeText(String(text)));
  handle('app:read-clipboard', () => clipboard.readText());
  handle('downloads:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('main.export.title'),
      defaultPath: `wasel-downloads-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return false;
    const exported = manager.exportState();
    const contents = /\.txt$/i.test(result.filePath)
      ? exported.downloads.map((item) => item.url).join('\r\n')
      : JSON.stringify(exported, null, 2);
    await fs.writeFile(result.filePath, contents, 'utf8');
    return true;
  });
  handle('downloads:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('main.import.title'),
      properties: ['openFile'],
      filters: [{ name: 'Wasel / JSON / Text', extensions: ['json', 'txt'] }]
    });
    if (result.canceled || !result.filePaths.length) return 0;
    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    let entries;
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed.downloads) ? parsed.downloads : Array.isArray(parsed.items) ? parsed.items : null;
    } catch {
      entries = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line)).map((url) => ({ url }));
    }
    if (!entries?.length) throw new Error('WASEL:import-empty:{}');
    let added = 0;
    for (const entry of entries.slice(0, 5000)) {
      if (!entry || typeof entry.url !== 'string') continue;
      try {
        await manager.add({ url: entry.url, fileName: typeof entry.fileName === 'string' ? entry.fileName : '', referer: entry.referer, startImmediately: false, source: 'import' });
        added += 1;
      } catch {
        // Skip malformed rows and keep importing the rest.
      }
    }
    return added;
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  ({ parseDownloadProtocolUrl } = await import('../extension/link-protocol.js'));
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('wasel', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('wasel');
  }
  const dataDirectory = path.join(app.getPath('userData'), 'downloads');
  await fs.mkdir(dataDirectory, { recursive: true });
  manager = new DownloadManager({
    dataFile: path.join(dataDirectory, 'library.json'),
    defaultFolder: path.join(app.getPath('downloads'), 'Wasel'),
    onChange: onDownloadsChanged,
    onEvent: onDownloadEvent,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url)
  });
  await manager.initialize();
  const settings = manager.getState().settings;
  nativeTheme.themeSource = settings.theme;
  await loadLocale(settings.language);
  if (settings.startWithWindows && app.isPackaged) {
    try {
      setWindowsStartup(true);
    } catch {
      // A failed refresh of the login item must not block startup.
    }
  }
  await prepareExtensionFolders();

  updates = new UpdateService({ app, autoUpdater, getSettings: () => manager.getState().settings });
  updates.on('state', (state) => send('updates:state', state));
  updates.on('ready', (info) => notify({
    title: t('main.notify.updateReady'),
    body: t('main.notify.updateReadyBody', { version: info.version }),
    onClick: () => {
      showMainWindow();
      send('app:open-settings', 'updates');
    }
  }));

  bridge = createBridgeServer({
    version: app.getVersion(),
    onDownload: handleBridgeDownload,
    getInfo: () => ({ askBeforeCapture: manager.getState().settings.askBeforeCapture })
  });
  await bridge.start();

  scheduler = new Scheduler({ manager });
  scheduler.start();
  registerIpc();
  await createWindow();
  createTray();
  startClipboardMonitor();
  updates.start();

  const startupUrl = process.argv.find((argument) => /^wasel:/i.test(argument));
  if (startupUrl) processProtocolUrl(startupUrl);

  app.on('activate', showMainWindow);
}).catch((error) => {
  dialog.showErrorBox('Wasel', error.stack || error.message);
  app.exit(1);
});

app.on('before-quit', (event) => {
  if (!manager || manager.shuttingDown) return;
  event.preventDefault();
  isQuitting = true;
  clearInterval(clipboardTimer);
  scheduler?.stop();
  updates?.stop();
  bridge?.stop();
  manager.shutdown().catch(() => {}).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') app.quit();
});
