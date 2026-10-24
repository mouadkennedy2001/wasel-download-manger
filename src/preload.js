const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('wasel', {
  info: invoke('app:info'),
  ready: invoke('app:ready'),
  openExternal: invoke('app:open-external'),
  copyText: invoke('app:copy-text'),
  readClipboard: invoke('app:read-clipboard'),
  listLanguages: invoke('languages:list'),
  getLanguage: invoke('languages:get'),
  windowAction: invoke('window:action'),
  isWindowMaximized: invoke('window:is-maximized'),

  getState: invoke('downloads:get-state'),
  add: invoke('downloads:add'),
  probe: invoke('downloads:probe'),
  pause: invoke('downloads:pause'),
  resume: invoke('downloads:resume'),
  restart: invoke('downloads:restart'),
  cancel: invoke('downloads:cancel'),
  remove: invoke('downloads:remove'),
  clearCompleted: invoke('downloads:clear-completed'),
  pauseAll: invoke('downloads:pause-all'),
  resumeAll: invoke('downloads:resume-all'),
  hash: invoke('downloads:hash'),
  updateSettings: invoke('downloads:update-settings'),
  chooseFolder: invoke('downloads:choose-folder'),
  setOutputFolder: invoke('downloads:set-output-folder'),
  openFile: invoke('downloads:open-file'),
  showFile: invoke('downloads:show-file'),
  openFolder: invoke('downloads:open-folder'),
  exportDownloads: invoke('downloads:export'),
  importDownloads: invoke('downloads:import'),

  getUpdateState: invoke('updates:get-state'),
  checkForUpdates: invoke('updates:check'),
  downloadUpdate: invoke('updates:download'),
  installUpdate: invoke('updates:install'),

  onChange: subscribe('downloads:changed'),
  onIncoming: subscribe('downloads:incoming'),
  onUpdateState: subscribe('updates:state'),
  onNotice: subscribe('app:notice'),
  onOpenSettings: subscribe('app:open-settings'),
  onWindowMaximized: subscribe('window:maximized'),
  onWindowFocus: subscribe('window:focus')
});
