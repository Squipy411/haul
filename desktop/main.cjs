// Haul for Windows (and macOS/Linux): either opens your Haul server, or runs Haul on this PC.
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const configFile = () => path.join(app.getPath('userData'), 'haul-desktop.json');
let mainWindow = null;
let localServer = null;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return null; }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

async function startLocalServer() {
  if (localServer) return localServer.url;
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'dist', 'server.mjs')).href);
  const videos = app.getPath('videos');
  const options = {
    host: '0.0.0.0',
    dataDir: path.join(app.getPath('userData'), 'data'),
    webDir: path.join(__dirname, '..', 'dist', 'web'),
    desktop: true,
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
    if (error && error.code !== 'EADDRINUSE') throw error;
    localServer = await startServer({ ...options, port: 0 });
  }
  return localServer.url;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#08090d',
    title: 'Haul',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^stremio:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('stremio:')) { event.preventDefault(); shell.openExternal(url); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function openHaul() {
  const config = readConfig();
  if (!config) return mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  try {
    const url = config.mode === 'remote' ? config.remoteUrl : await startLocalServer();
    await mainWindow.loadURL(url);
  } catch (error) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Haul',
      message: config.mode === 'remote' ? `Can't reach your Haul server at ${config.remoteUrl}.` : 'Haul could not start on this PC.',
      detail: String(error && error.message ? error.message : error),
      buttons: ['Try again', 'Change setup', 'Quit']
    });
    if (choice.response === 0) return openHaul();
    if (choice.response === 1) return mainWindow.loadFile(path.join(__dirname, 'setup.html'));
    app.quit();
  }
}

ipcMain.handle('haul:get-config', () => readConfig());
ipcMain.handle('haul:save-config', async (_event, config) => {
  if (config.mode === 'remote') {
    const url = String(config.remoteUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error('Enter an address that starts with http:// or https://');
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!response || !response.ok) throw new Error(`No Haul server answered at ${url}`);
    writeConfig({ mode: 'remote', remoteUrl: url });
  } else {
    writeConfig({ mode: 'local' });
  }
  await openHaul();
  return true;
});

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Haul',
      submenu: [
        { label: 'Change server…', click: () => mainWindow && mainWindow.loadFile(path.join(__dirname, 'setup.html')) },
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
    app.on('activate', () => { if (!mainWindow) { createWindow(); openHaul(); } });
  });
  app.on('window-all-closed', async () => {
    if (localServer) await localServer.close().catch(() => undefined);
    app.quit();
  });
}
