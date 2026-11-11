// Server app for Species Specific VoIP (The Isle Evrima).
// A double-click way to run the voice server: it starts the server, shows the
// first-run setup page or the admin panel in a window, and keeps running in
// the system tray. No command line and no file editing.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pkg = require('./package.json');
const NAME = 'Species Specific VoIP Server (The Isle Evrima)';
const versionLabel = `v${pkg.version}${pkg.releaseStage ? ` (${pkg.releaseStage})` : ''}`;
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const serverDir = path.join(resources, 'server');
const iconFile = app.isPackaged ? path.join(resources, 'icon.png') : path.join(__dirname, 'build', 'icon.png');

let win = null;
let tray = null;
let state = { mode: 'starting' };
let quitting = false;

// Settings, the admin password hash and the log live in this user's app-data
// folder, so updating or reinstalling the app never touches them.
const dataRoot = () => app.getPath('userData');
const configFile = () => path.join(dataRoot(), 'config.json');
const logFile = () => path.join(dataRoot(), 'server.log');

function log(...parts) {
  const line = parts.join(' ');
  try {
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {}
  console.log(line);
}

const isLocal = (url) => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

function showWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 1180, height: 820, minWidth: 520, minHeight: 600,
      autoHideMenuBar: true, backgroundColor: '#17140f', title: NAME, ...(process.platform === 'linux' ? { icon: iconFile } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !isLocal(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // The window only ever shows this computer's own server pages.
    win.webContents.on('will-navigate', (e, url) => {
      if (isLocal(url)) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    });
    win.on('close', (e) => {
      if (quitting || !tray) return;
      e.preventDefault(); // keep the voice server running in the tray
      win.hide();
      if (process.platform === 'win32' && !showWindow.toldOnce) {
        showWindow.toldOnce = true;
        tray.displayBalloon({ title: NAME, content: 'The voice server is still running. Use this icon to open the admin panel or quit.' });
      }
    });
    win.on('closed', () => { win = null; });
    if (state.localUrl) win.loadURL(state.localUrl);
  }
  if (win.isMinimized()) win.restore();
  win.show();
}

function onState(next) {
  const wasSetup = state.mode === 'setup';
  state = next;
  log(`state: ${next.mode}${next.message ? ' - ' + next.message : ''}`);
  if (next.mode === 'error') {
    const choice = dialog.showMessageBoxSync({
      type: 'error', title: NAME, message: 'The voice server could not start.', detail: next.message,
      buttons: ['Run setup again', 'Open settings folder', 'Quit'], defaultId: 0, cancelId: 2
    });
    if (choice === 0) return runSetupAgain(false);
    if (choice === 1) shell.openPath(dataRoot());
    quitting = true;
    return app.quit();
  }
  // After setup, leave its "what to do next" page on screen; its button opens the admin panel.
  if (next.mode === 'running' && wasSetup) return;
  if (win && next.localUrl) win.loadURL(next.localUrl);
}

function runSetupAgain(ask = true) {
  if (ask) {
    const ok = dialog.showMessageBoxSync({
      type: 'question', title: NAME, message: 'Run setup again?',
      detail: 'The voice server stops and asks the setup questions again. Your talk rules and species are kept, and you choose the admin password again. The current connection settings are saved as a backup.',
      buttons: ['Run setup again', 'Cancel'], defaultId: 1, cancelId: 1
    });
    if (ok !== 0) return;
  }
  try {
    if (fs.existsSync(configFile())) fs.renameSync(configFile(), path.join(dataRoot(), `config.backup-${Date.now()}.json`));
  } catch {}
  quitting = true;
  app.relaunch();
  app.exit(0);
}

function buildTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(iconFile).resize({ width: 16, height: 16 }));
  } catch {
    tray = null; // no system tray here: closing the window will quit instead
    return;
  }
  const canAutoStart = process.platform === 'win32' || process.platform === 'darwin';
  const menu = () => Menu.buildFromTemplate([
    { label: `${NAME} ${versionLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Open admin panel', click: showWindow },
    { label: 'Open settings folder', click: () => shell.openPath(dataRoot()) },
    { label: 'Open log', click: () => shell.openPath(logFile()) },
    ...(canAutoStart ? [{
      label: 'Start when I sign in to this computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); tray.setContextMenu(menu()); }
    }] : []),
    { type: 'separator' },
    { label: 'Run setup again…', click: () => runSetupAgain(true) },
    { label: 'Quit (stops the voice server)', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setToolTip(NAME);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
}

ipcMain.on('app:versionLabel', (e) => { e.returnValue = versionLabel; });
ipcMain.on('app:setupFinished', () => {});
ipcMain.handle('app:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a file', properties: ['openFile'], filters: [{ name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});

// The admin panel is loaded from this computer as https://localhost, but the
// certificate is for your public voice address, so the name never matches.
// Accept that for this app's own server on this computer, and nothing else.
app.on('certificate-error', (event, _wc, url, _err, _cert, done) => {
  let ours = false;
  try {
    const u = new URL(url);
    ours = isLocal(url) && Number(u.port) === state.port;
  } catch {}
  if (ours) event.preventDefault();
  done(ours);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showWindow);
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  fs.mkdirSync(dataRoot(), { recursive: true });
  process.env.ISLE_VOIP_CONFIG = configFile();
  process.env.ISLE_VOIP_DATA = path.join(dataRoot(), 'data');
  buildTray();
  if (!process.argv.includes('--hidden') || !tray) showWindow();
  try {
    const { run } = await import(pathToFileURL(path.join(serverDir, 'src', 'launch.js')).href);
    await run({ onState, log });
    if (state.mode === 'setup') showWindow(); // setup always needs the window, even when started hidden
  } catch (err) {
    if (state.mode !== 'error') onState({ mode: 'error', message: err.message });
  }
});
