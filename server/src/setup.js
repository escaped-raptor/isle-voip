// First-run setup. When there is no config file yet, the server starts this
// small page instead of the voice service, so the whole install can be done
// in a browser with no file editing.
//
// It listens on this computer only (127.0.0.1) and needs the one-time key in
// its address, so nobody else on the network, and no other web page, can
// configure your server.
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import { ensureAutoCertificate, inspectCertificate } from './certs.js';
import { Store } from './store.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 7777; // same number as the game port
export const DEFAULT_AUDIO_PORT = 40000;

const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const portOf = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what} must be a number from 1 to 65535.`);
  return n;
};

/** SteamID64s from a textarea: one per line or separated by commas or spaces. At most 30. */
export function parseWhitelist(input) {
  return [...new Set(String(input ?? '').split(/[\s,;]+/).filter((v) => /^\d{17}$/.test(v)))].slice(0, 30);
}

/** Turn the setup form into a config object. Throws a readable message on bad input. */
export function buildConfig(form) {
  form = form || {};
  const name = text(form.name, 80) || 'My Isle Server';
  const port = portOf(form.port ?? DEFAULT_PORT, 'The voice port');
  const audioPort = portOf(form.audioPort ?? DEFAULT_AUDIO_PORT, 'The audio port');
  const mode = ['certificate', 'auto', 'proxy', 'test'].includes(form.mode) ? form.mode : 'certificate';

  if (mode === 'test') {
    if (!parseWhitelist(form.whitelist).length) throw new Error('Testing mode needs a whitelist: enter the SteamID64 (17 digits) of each player allowed to connect, up to 30.');
    return {
      name, port,
      publicUrl: `http://localhost:${port}`,
      tls: { cert: '', key: '' },
      host: '127.0.0.1', // listen on this computer only
      rtc: { announcedAddress: '127.0.0.1', listenIp: '127.0.0.1', port: audioPort },
      authMode: 'dev',
      trustProxy: false
    };
  }

  const host = text(form.address, 255).replace(/^https?:\/\//i, '').replace(/[/:].*$/, '');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || !host.includes('.')) {
    throw new Error('Enter the voice address players will use, like voice.example.com.');
  }
  const ip = text(form.publicIp, 60);
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) {
    throw new Error("Enter this server's public IP address, like 203.0.113.10.");
  }

  if (mode === 'proxy') {
    const publicPort = portOf(form.publicPort ?? 443, 'The public port');
    return {
      name, port,
      publicUrl: `https://${host}${publicPort === 443 ? '' : ':' + publicPort}`,
      tls: { cert: '', key: '' },
      rtc: { announcedAddress: ip, port: audioPort },
      authMode: 'steam',
      trustProxy: 1
    };
  }

  if (mode === 'auto') {
    if (form.agree !== true) throw new Error("Tick the box to agree to the Let's Encrypt Subscriber Agreement. The free certificate is issued under it.");
    const email = text(form.email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look right. It is optional: leave it empty if you prefer.');
    return {
      name, port,
      publicUrl: `https://${host}${port === 443 ? '' : ':' + port}`,
      tls: { cert: '', key: '', auto: { agreedToTerms: true, ...(email ? { email } : {}) } },
      rtc: { announcedAddress: ip, port: audioPort },
      authMode: 'steam',
      trustProxy: false
    };
  }

  const cert = text(form.cert, 500).replace(/^"|"$/g, '');
  const key = text(form.key, 500).replace(/^"|"$/g, '');
  if (!cert && !key) throw new Error('No certificate chosen. Choose the certificate and key files, or pick "I don\'t have one" to get a free certificate automatically.');
  for (const [file, what] of [[cert, 'certificate'], [key, 'private key']]) {
    if (!file) throw new Error(`Choose the ${what} file.`);
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch {
      throw new Error(`Can't read the ${what} file at ${file}. Check the path.`);
    }
  }
  // Only certificates from publicly trusted authorities are accepted.
  inspectCertificate({ certPem: fs.readFileSync(cert, 'utf8'), keyPem: fs.readFileSync(key, 'utf8'), host, extraRoots: form.__extraRoots });
  return {
    name, port,
    publicUrl: `https://${host}${port === 443 ? '' : ':' + port}`,
    tls: { cert, key },
    rtc: { announcedAddress: ip, port: audioPort },
    authMode: 'steam',
    trustProxy: false
  };
}

/**
 * Serve the setup page until it is completed, then call onDone(config).
 * Returns { url, close }.
 */
export async function startSetup({ configFile, dataDir, onDone, log = console.log, extraTrustedRoots, acme = {} }) {
  const key = crypto.randomBytes(18).toString('base64url');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const guard = (req, res, next) => (req.headers['x-setup-key'] === key ? next() : res.status(403).json({ error: 'Open the setup page from the server app or the address it printed.' }));

  app.get('/api/info', (req, res) => res.json({ setup: true })); // not the voice service yet: clients stay quiet
  app.post('/api/setup/detect-ip', guard, async (req, res) => {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
      res.json({ ip: (await r.json()).ip });
    } catch {
      res.status(502).json({ error: "Couldn't look it up. Type it in: your host's control panel shows it, or search the web for \"what is my IP\" on this server." });
    }
  });
  // Declared before the routes that use it.
  let server = null;
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });

  let busy = false;
  app.post('/api/setup', guard, async (req, res) => {
    if (busy) return res.status(409).json({ error: 'Setup is already being saved. Wait a moment.' });
    busy = true;
    try {
      const form = { ...(req.body || {}), __extraRoots: extraTrustedRoots };
      const password = String(form.password || '');
      if (password.length < 10) throw new Error('Choose an admin password of at least 10 characters.');
      const config = buildConfig(form);
      let https = null;
      if (config.tls.auto) {
        // Get the free certificate now, so any problem is shown on this page
        // instead of the server failing to start afterwards.
        Object.assign(config.tls.auto, acme.directoryUrl ? { directoryUrl: acme.directoryUrl } : {}, acme.challengePort ? { challengePort: acme.challengePort } : {});
        const got = await ensureAutoCertificate({
          dir: path.join(dataDir, 'certificates'), host: new URL(config.publicUrl).hostname, email: config.tls.auto.email,
          directoryUrl: config.tls.auto.directoryUrl, challengePort: config.tls.auto.challengePort, extraRoots: extraTrustedRoots, log
        });
        https = got.info;
      }
      new Auth(dataDir).setAdminPassword(password);
      if (config.authMode === 'dev') {
        const store = new Store(dataDir);
        store.update({ ...store.get(), testAccess: { whitelist: parseWhitelist(form.whitelist) } });
      }
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
      const secure = Boolean(config.tls.cert || config.tls.auto);
      const local = `${secure ? 'https' : 'http'}://localhost:${config.port}/admin/`;
      res.json({ localUrl: local, publicUrl: `${config.publicUrl}/admin/`, port: config.port, audioPort: config.rtc.port, https, testing: config.authMode === 'dev' });
      setTimeout(async () => {
        await close();
        onDone(config);
      }, 300);
    } catch (err) {
      busy = false;
      res.status(400).json({ error: err.message });
    }
  });
  app.use('/shared', express.static(path.join(root, '..', 'shared')));
  app.use('/setup', express.static(path.join(root, 'public', 'setup')));
  app.get('/', (req, res) => res.redirect('/setup/'));

  server = http.createServer(app);
  // Prefer the usual port so the address is predictable; fall back to any free one.
  const port = await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    server.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(server.address().port));
  });
  const url = `http://localhost:${port}/setup/#key=${key}`;
  log('This server has not been set up yet.');
  log(`  Open this address in a browser on this computer to set it up:\n  ${url}`);
  return { url, port, key, close };
}
