// Desktop shell for the Species Specific VoIP (The Isle Evrima) client.
// Adds what a web page cannot do: push-to-talk that works while the game has
// focus, pressing the game's call key, and Steam sign-in in its own window.
const { app, BrowserWindow, ipcMain, safeStorage, session, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const KEY_NAMES = Object.fromEntries(Object.entries(UiohookKey).map(([name, code]) => [code, name]));
const MOUSE_NAMES = { 3: 'Middle mouse', 4: 'Mouse 4', 5: 'Mouse 5' };

let win = null;
let ptt = null; // { kind: 'key' | 'mouse', code }
let pttDown = false;
let capture = null; // resolver waiting for the next key press
let ignoreUntil = 0; // ignore our own synthetic key presses

// ---- saved preferences (no passwords or tokens are ever written to disk) ----

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return next;
}

function serverOrigin(input) {
  const url = new URL(String(input));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The server address must start with https://');
  }
  return url.origin;
}

// ---- saved sign-in -------------------------------------------------------------
// "Stay signed in" keeps the voice server's session token (never a password) so
// the app can reconnect by itself after a restart. It is encrypted by the
// operating system for this user account (DPAPI on Windows, Keychain on macOS).
// If the system can't encrypt, nothing is saved.

const sessions = () => {
  const s = readConfig().sessions;
  return s && typeof s === 'object' ? s : {};
};
ipcMain.handle('session:load', (_e, server) => {
  try {
    const saved = sessions()[server];
    if (!saved || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(saved, 'base64'));
  } catch {
    return null;
  }
});
ipcMain.handle('session:save', (_e, server, token) => {
  if (!safeStorage.isEncryptionAvailable() || typeof token !== 'string') return false;
  const origin = serverOrigin(server);
  const all = sessions();
  delete all[origin];
  all[origin] = safeStorage.encryptString(token).toString('base64');
  // keep the five most recently used servers
  writeConfig({ sessions: Object.fromEntries(Object.entries(all).slice(-5)) });
  return true;
});
ipcMain.handle('session:clear', (_e, server) => {
  const all = sessions();
  if (server) delete all[server];
  writeConfig({ sessions: server ? all : {} });
});

// ---- global keys -------------------------------------------------------------

function sendPtt(down) {
  if (pttDown === down) return;
  pttDown = down;
  win?.webContents.send('ptt', down);
}

function onPress(kind, code) {
  if (Date.now() < ignoreUntil) return;
  if (capture) {
    const done = capture;
    capture = null;
    const name = kind === 'key' ? KEY_NAMES[code] || `Key ${code}` : MOUSE_NAMES[code];
    return done({ kind, code, name });
  }
  if (ptt && ptt.kind === kind && ptt.code === code) sendPtt(true);
}
function onRelease(kind, code) {
  if (ptt && ptt.kind === kind && ptt.code === code) sendPtt(false);
}

uIOhook.on('keydown', (e) => onPress('key', e.keycode));
uIOhook.on('keyup', (e) => onRelease('key', e.keycode));
uIOhook.on('mousedown', (e) => MOUSE_NAMES[e.button] && onPress('mouse', e.button));
uIOhook.on('mouseup', (e) => MOUSE_NAMES[e.button] && onRelease('mouse', e.button));

ipcMain.handle('config:get', () => {
  const { sessions: _hidden, ...rest } = readConfig();
  return rest;
});
ipcMain.handle('config:set', (_e, patch) => {
  const { sessions: _ignored, ...safe } = patch || {}; // the page cannot overwrite the saved sign-in this way
  writeConfig(safe);
});
ipcMain.handle('keys:setPtt', (_e, binding) => {
  ptt = binding && Number.isInteger(binding.code) ? { kind: binding.kind === 'mouse' ? 'mouse' : 'key', code: binding.code } : null;
  sendPtt(false);
});
ipcMain.handle('keys:capture', () => new Promise((resolve) => {
  capture = resolve;
  setTimeout(() => { if (capture === resolve) { capture = null; resolve(null); } }, 8000);
}));
ipcMain.handle('keys:tap', async (_e, code) => {
  // Hold the key briefly: games read the keyboard once per frame and can miss an instant tap.
  if (!Number.isInteger(code) || !KEY_NAMES[code]) return;
  ignoreUntil = Date.now() + 250;
  uIOhook.keyToggle(code, 'down');
  await new Promise((r) => setTimeout(r, 70));
  uIOhook.keyToggle(code, 'up');
});

// ---- Steam sign-in -----------------------------------------------------------

ipcMain.handle('auth:steam', (_e, server) => new Promise((resolve, reject) => {
  let origin;
  try { origin = serverOrigin(server); } catch (err) { return reject(err); }
  const login = new BrowserWindow({
    width: 520, height: 760, parent: win, modal: true, autoHideMenuBar: true,
    webPreferences: { partition: 'persist:steam-login', sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  let settled = false;
  const check = (_event, url) => {
    const at = typeof url === 'string' ? url : login.webContents.getURL();
    if (!at.startsWith(`${origin}/auth-done.html`)) return;
    const token = new URLSearchParams(new URL(at).hash.slice(1)).get('token');
    if (token && !settled) { settled = true; resolve(token); login.close(); }
  };
  login.webContents.on('will-redirect', check);
  login.webContents.on('did-navigate', check);
  login.webContents.on('did-finish-load', () => check());
  login.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  login.on('closed', () => settled || reject(new Error('Sign-in window closed.')));
  login.loadURL(`${origin}/auth/steam`);
}));

// ---- window ------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 720, minWidth: 420, minHeight: 560,
    autoHideMenuBar: true, backgroundColor: '#17140f', title: 'Species Specific VoIP (The Isle Evrima)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false // keep voice detection running while the game has focus
    }
  });
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

// Only one copy of the client runs at a time; starting it again shows the open window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
});

app.whenReady().then(() => {
  // Only this app's own page may use the microphone; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && wc === win?.webContents && wc.getURL().startsWith('file://'));
  });
  // macOS asks the user once for microphone access at the system level.
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});
  createWindow();
  uIOhook.start();
});
app.on('window-all-closed', () => { try { uIOhook.stop(); } catch {} app.quit(); });
