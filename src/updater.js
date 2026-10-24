const { EventEmitter } = require('node:events');

const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 8000;

// Wraps electron-updater in a small state machine the renderer can display directly.
// Releases are public GitHub releases, so no token is needed on users' machines.
class UpdateService extends EventEmitter {
  constructor({ app, autoUpdater, getSettings }) {
    super();
    this.app = app;
    this.updater = autoUpdater;
    this.getSettings = getSettings;
    this.state = { status: 'idle', version: null, progress: 0, notes: '', error: null, checkedAt: null, current: app.getVersion() };
    this.started = false;
  }

  setState(changes) {
    this.state = { ...this.state, ...changes };
    this.emit('state', this.state);
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.app.isPackaged) {
      this.setState({ status: 'unsupported' });
      return;
    }
    const updater = this.updater;
    updater.autoDownload = this.getSettings().autoUpdate;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    updater.on('checking-for-update', () => this.setState({ status: 'checking', error: null }));
    updater.on('update-available', (info) => this.setState({
      status: updater.autoDownload ? 'downloading' : 'available',
      version: info.version,
      notes: releaseNotes(info.releaseNotes),
      progress: 0
    }));
    updater.on('update-not-available', () => this.setState({ status: 'none', checkedAt: Date.now() }));
    updater.on('download-progress', (progress) => this.setState({
      status: 'downloading',
      progress: Math.round(progress.percent),
      speed: progress.bytesPerSecond
    }));
    updater.on('update-downloaded', (info) => {
      this.setState({ status: 'ready', version: info.version, progress: 100, checkedAt: Date.now() });
      this.emit('ready', info);
    });
    updater.on('error', (error) => this.setState({ status: 'error', error: describeUpdateError(error), checkedAt: Date.now() }));
    setTimeout(() => this.check().catch(() => {}), FIRST_CHECK_DELAY).unref();
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_INTERVAL);
    this.timer.unref();
  }

  async check() {
    if (!this.app.isPackaged) {
      this.setState({ status: 'unsupported' });
      return this.state;
    }
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.updater.autoDownload = this.getSettings().autoUpdate;
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.setState({ status: 'error', error: describeUpdateError(error), checkedAt: Date.now() });
    }
    return this.state;
  }

  async download() {
    if (this.state.status !== 'available') return this.state;
    this.setState({ status: 'downloading', progress: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setState({ status: 'error', error: describeUpdateError(error) });
    }
    return this.state;
  }

  install() {
    if (this.state.status !== 'ready') return false;
    setImmediate(() => this.updater.quitAndInstall(false, true));
    return true;
  }

  stop() {
    clearInterval(this.timer);
  }
}

function releaseNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((entry) => entry.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim().slice(0, 4000);
}

function describeUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/latest\.yml|404|Cannot find channel/i.test(message)) return 'no-metadata';
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED/i.test(message)) return 'offline';
  if (/rate limit|403/i.test(message)) return 'rate-limited';
  if (/sha512|checksum/i.test(message)) return 'corrupt';
  return 'unknown';
}

module.exports = { UpdateService, describeUpdateError };
