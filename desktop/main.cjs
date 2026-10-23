// Haul for Windows (also runs on macOS and Linux): opens a Haul server, or runs Haul on this PC.
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (process.env.HAUL_USER_DATA) app.setPath('userData', process.env.HAUL_USER_DATA);

const RELEASES = 'https://api.github.com/repos/Squipy411/haul/releases/latest';
const configFile = () => path.join(app.getPath('userData'), 'haul-desktop.json');
let mainWindow = null;
let localServer = null;
let localShared = false;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return null; }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

/** Runs the Haul server inside the app. Private to this PC unless `share` is on. */
async function startLocalServer(share) {
  if (localServer && localShared === share) return localServer;
  if (localServer) { await localServer.close(); localServer = null; }
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'dist', 'server.mjs')).href);
  const videos = app.getPath('videos');
  const options = {
    host: share ? '0.0.0.0' : '127.0.0.1',
    dataDir: path.join(app.getPath('userData'), 'data'),
    webDir: path.join(__dirname, '..', 'dist', 'web'),
    desktop: true,
    auth: 'desktop',
    defaults: {
      torboxApiKey: '',
      moviesDir: path.join(videos, 'Movies'),
      tvDir: path.join(videos, 'TV Shows'),
      incompleteDir: path.join(videos, 'Haul Downloads'),
      publicUrl: ''
    }
  };
  try {
    localServer = await startServer({ ...options, port: 60700 });
  } catch (error) {
    if (!error || error.code !== 'EADDRINUSE') throw error;
    localServer = await startServer({ ...options, port: 0 });
  }
  localShared = share;
  return localServer;
}

function isInternal(target, current) {
  try {
    const next = new URL(target);
    const now = new URL(current);
    return next.protocol === 'file:' ? now.protocol === 'file:' : next.origin === now.origin;
  } catch {
    return false;
  }
}

function openOutside(url) {
  if (/^(https?|stremio):/i.test(url)) shell.openExternal(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0f0f0d',
    title: 'Haul',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // Haul's own pages stay in the window; everything else opens in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url, mainWindow.webContents.getURL())) { event.preventDefault(); openOutside(url); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function openHaul() {
  const config = readConfig();
  if (!config) return mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  try {
    if (config.mode === 'remote') {
      await mainWindow.loadURL(config.remoteUrl);
    } else {
      const server = await startLocalServer(Boolean(config.share));
      // The app signs its own window in; other devices need the password set in Settings.
      const session = server.desktopSession();
      await mainWindow.webContents.session.cookies.set({
        url: server.url, name: session.name, value: session.value, httpOnly: true, sameSite: 'strict', expirationDate: Math.floor(session.expires / 1000)
      });
      await mainWindow.loadURL(server.url);
    }
  } catch (error) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Haul',
      message: config.mode === 'remote' ? `Can't reach the Haul server at ${config.remoteUrl}.` : 'Haul could not start on this PC.',
      detail: String(error && error.message ? error.message : error),
      buttons: ['Try again', 'Change setup', 'Quit']
    });
    if (choice.response === 0) return openHaul();
    if (choice.response === 1) return mainWindow.loadFile(path.join(__dirname, 'setup.html'));
    app.quit();
  }
}

async function checkForUpdate({ manual = false } = {}) {
  const config = readConfig() || {};
  if (!manual && config.lastUpdateCheck && Date.now() - config.lastUpdateCheck < 86_400_000) return;
  try {
    const response = await fetch(RELEASES, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': `Haul/${app.getVersion()}` } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = await response.json();
    if (readConfig()) writeConfig({ ...readConfig(), lastUpdateCheck: Date.now() });
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const parts = (value) => value.split('.').map((part) => Number(part) || 0);
    const [a, b] = [parts(latest), parts(app.getVersion())];
    const isNewer = a.some((value, index) => value !== (b[index] || 0)) && (a[0] - (b[0] || 0) || a[1] - (b[1] || 0) || a[2] - (b[2] || 0)) > 0;
    if (isNewer) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Haul', message: `Haul ${latest} is available.`, detail: `You have ${app.getVersion()}.`, buttons: ['Download', 'Later'], defaultId: 0
      });
      if (choice.response === 0) openOutside(release.html_url || 'https://github.com/Squipy411/haul/releases');
    } else if (manual) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Haul', message: `Haul ${app.getVersion()} is the latest version.` });
    }
  } catch (error) {
    if (manual) await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Haul', message: 'Could not check for updates.', detail: String(error.message || error) });
  }
}

// Only the bundled setup screen may read or change where Haul runs.
const fromSetup = (event) => Boolean(event.senderFrame && event.senderFrame.url.startsWith('file:'));

ipcMain.handle('haul:get-config', (event) => (fromSetup(event) ? readConfig() : null));
ipcMain.handle('haul:save-config', async (event, config) => {
  if (!fromSetup(event)) throw new Error('Not allowed');
  if (config.mode === 'remote') {
    const url = String(config.remoteUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('Enter the server address, starting with http:// or https://');
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    const body = response && response.ok ? await response.json().catch(() => null) : null;
    if (!body || body.status !== 'ok') throw new Error(`No Haul server answered at ${url}`);
    writeConfig({ ...(readConfig() || {}), mode: 'remote', remoteUrl: url });
  } else {
    writeConfig({ ...(readConfig() || {}), mode: 'local', share: Boolean(config.share) });
  }
  await openHaul();
  return true;
});

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Haul',
      submenu: [
        { label: 'Change where Haul runs…', click: () => mainWindow && mainWindow.loadFile(path.join(__dirname, 'setup.html')) },
        { label: 'Check for updates…', click: () => checkForUpdate({ manual: true }) },
        { label: 'Open downloads folder', click: () => shell.openPath(path.join(app.getPath('videos'))) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    openHaul();
    setTimeout(() => checkForUpdate(), 8000);
    app.on('activate', () => { if (!mainWindow) { createWindow(); openHaul(); } });
  });
  app.on('window-all-closed', async () => {
    if (localServer) await localServer.close().catch(() => undefined);
    app.quit();
  });
}
