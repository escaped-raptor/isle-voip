// HTTP(S) + WebSocket front end: sign-in, the admin API, static pages and
// the signalling channel players use to set up their encrypted audio.
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Auth, steamLoginUrl, verifySteamReturn } from './auth.js';
import { Hub } from './hub.js';
import { ensureAutoCertificate, loadCertificate } from './certs.js';
import { createSfu } from './sfu.js';
import { SpeciesSource } from './species-source.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = PKG.version;
// What the GUIs show in the bottom-left corner, for example "v0.2.3 (Alpha)".
const VERSION_LABEL = `v${PKG.version}${PKG.releaseStage ? ` (${PKG.releaseStage})` : ''}`;
const APP_NAME = 'Species Specific VoIP (The Isle Evrima)';
// How a client recognises this service before it tries to connect, and how
// each side checks the other speaks the same protocol. Raise PROTOCOL when a
// change means older clients and newer servers can no longer talk.
// A sign-in lasts 30 days, so the client can reconnect on its own after a restart.
const PLAYER_SESSION_SECONDS = 30 * 24 * 3600;
export const SERVICE = 'species-voip';
export const PROTOCOL = 1;

/** Allow at most `max` events per `windowMs` for each key. Kept in memory only, never logged. */
function limiter(max, windowMs) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, list] of hits) if (!list.some((t) => t > cutoff)) hits.delete(k);
  }, windowMs);
  sweep.unref?.();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length <= max;
  };
}

// Testing mode (authMode "dev") is only for trying things out: at most this
// many players, and only SteamIDs on the testing whitelist.
export const TEST_MODE_MAX_PLAYERS = 30;

export async function startServer(config, { quiet = false, log: logTo = console.log, extraTrustedRoots } = {}) {
  const log = (...a) => quiet || logTo(...a);
  const dataDir = path.resolve(root, config.dataDir || './data');
  const store = new Store(dataDir);
  const auth = new Auth(dataDir);
  const firstPassword = auth.ensureAdminPassword();

  // Default: the same port number as the game server. The game uses it over UDP,
  // this service uses it over TCP, so both can run on one machine.
  config = { ...config, port: config.port ?? 7777 };

  // ---- HTTPS ---------------------------------------------------------------
  // Either the admin provides a certificate, which must come from a publicly
  // trusted authority, or (when none is provided and they agreed on the setup
  // page) the server gets a free one from Let's Encrypt and keeps it renewed.
  // With neither, it serves plain HTTP for a reverse proxy or for testing.
  const manualTls = Boolean(config.tls?.cert && config.tls?.key);
  const autoTls = !manualTls && Boolean(config.tls?.auto?.agreedToTerms);
  const useTls = manualTls || autoTls;
  const certHost = (() => {
    try {
      return new URL(config.publicUrl).hostname;
    } catch {
      return null;
    }
  })();
  const certDir = path.join(dataDir, 'certificates');
  const getCertificate = async () => {
    if (manualTls) return loadCertificate({ certFile: config.tls.cert, keyFile: config.tls.key, host: certHost, extraRoots: extraTrustedRoots });
    if (!certHost) throw new Error('Automatic HTTPS needs publicUrl to be set to your voice address.');
    return ensureAutoCertificate({
      dir: certDir, host: certHost, email: config.tls.auto.email,
      directoryUrl: config.tls.auto.directoryUrl, challengePort: config.tls.auto.challengePort,
      extraRoots: extraTrustedRoots, log: (...a) => log('[https]', ...a)
    });
  };
  let certificate = useTls ? await getCertificate() : null; // throws with a readable reason if it can't be trusted

  const source = new SpeciesSource(() => store.get());
  const sfu = await createSfu({
    listenIp: config.rtc?.listenIp || '0.0.0.0',
    announcedAddress: config.rtc?.announcedAddress,
    port: config.rtc?.port || 40000
  });
  const hub = new Hub({ store, sfu, source, log: (...a) => log('[hub]', ...a) });

  let publicUrl = String(config.publicUrl || `${useTls ? 'https' : 'http'}://localhost:${config.port}`).replace(/\/$/, '');
  const authMode = config.authMode === 'dev' ? 'dev' : 'steam';
  const webClientDir = path.join(root, '..', 'client', 'dist');
  const hasWebClient = fs.existsSync(path.join(webClientDir, 'index.html'));

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob: mediastream:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
    );
    if (useTls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  // A client that keeps knocking is slowed down instead of being served forever.
  const limits = config.limits || {};
  const httpAllowed = limiter(limits.httpPerMinute || 120, 60_000);
  const wsAllowed = limiter(limits.connectionsPerMinute || 20, 60_000);
  const addressOf = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  app.use(['/api/info', '/auth'], (req, res, next) => {
    if (httpAllowed(addressOf(req))) return next();
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  });

  // ---- public ------------------------------------------------------------

  app.get('/api/info', (req, res) => {
    res.json({ service: SERVICE, protocol: PROTOCOL, publicUrl, app: APP_NAME, name: config.name || APP_NAME, version: VERSION, versionLabel: VERSION_LABEL, authMode, source: source.type, webClient: hasWebClient });
  });

  app.get('/auth/steam', (req, res) => {
    if (authMode !== 'steam') return res.status(404).send('Steam sign-in is turned off on this server.');
    res.redirect(steamLoginUrl(publicUrl));
  });

  app.get('/auth/steam/return', async (req, res) => {
    try {
      const steamId = await verifySteamReturn(req.query, publicUrl);
      const token = auth.sign({ sub: steamId, role: 'player' }, PLAYER_SESSION_SECONDS);
      res.redirect(`/auth-done.html#token=${token}`);
    } catch (err) {
      res.status(400).type('text/plain').send(`Sign-in failed: ${err.message}`);
    }
  });

  // Development only: hands a token to anyone for any SteamID.
  app.get('/auth/dev', (req, res) => {
    if (authMode !== 'dev') return res.status(404).end();
    const steamId = String(req.query.steamId || '');
    if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'A SteamID64 is 17 digits.' });
    if (!store.get().testAccess.whitelist.includes(steamId)) return res.status(403).json({ error: "That SteamID is not on this server's testing whitelist. Ask the server's admins to add it." });
    res.json({ token: auth.sign({ sub: steamId, role: 'player' }, PLAYER_SESSION_SECONDS) });
  });

  // ---- admin API ---------------------------------------------------------

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!auth.loginAllowed(ip)) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 5 minutes.' });
    const ok = auth.checkAdminPassword(req.body?.password);
    auth.recordLogin(ip, ok);
    if (!ok) return res.status(401).json({ error: 'Wrong password.' });
    res.json({ token: auth.sign({ role: 'admin' }, 8 * 3600) });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth.verify(token)?.role !== 'admin') return res.status(401).json({ error: 'Sign in again.' });
    next();
  });
  admin.get('/settings', (req, res) => res.json(store.getRedacted()));
  admin.put('/settings', (req, res) => {
    try {
      store.update(req.body);
      hub.onSettingsChanged();
      res.json(store.getRedacted());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  admin.get('/status', (req, res) => res.json({
    ...hub.adminStatus(),
    https: certificate ? { mode: manualTls ? 'provided' : 'automatic', ...certificate.info } : { mode: authMode === 'dev' ? 'testing' : 'proxy' },
    testing: authMode === 'dev' ? { maxPlayers: TEST_MODE_MAX_PLAYERS } : null
  }));
  admin.post('/test-source', async (req, res) => {
    try {
      res.json(await source.test());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  admin.post('/password', (req, res) => {
    try {
      if (!auth.checkAdminPassword(req.body?.current)) throw new Error('The current password is wrong.');
      auth.setAdminPassword(req.body?.next);
      res.json({});
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.use('/api/admin', admin);

  // ---- static pages ------------------------------------------------------

  app.use('/shared', express.static(path.join(root, '..', 'shared')));
  if (hasWebClient) app.use('/play', express.static(webClientDir));
  app.use(express.static(path.join(root, 'public')));
  app.get('/', (req, res) => res.redirect(hasWebClient ? '/play/' : '/admin/'));

  // ---- signalling --------------------------------------------------------

  const server = useTls ? https.createServer({ cert: certificate.cert, key: certificate.key }, app) : http.createServer(app);

  // Twice a day: renew the automatic certificate when it is due, or pick up a
  // provided certificate that another tool has renewed on disk. The new one is
  // swapped in without restarting or dropping anyone.
  let certTimer = null;
  if (useTls) {
    certTimer = setInterval(async () => {
      try {
        const next = await getCertificate();
        if (next.cert !== certificate.cert) {
          server.setSecureContext({ cert: next.cert, key: next.key });
          log(`[https] Now using the certificate valid until ${new Date(next.info.validTo).toDateString()}.`);
        }
        certificate = next;
        if (manualTls && next.info.daysLeft < 14) log(`[https] WARNING: the certificate expires in ${next.info.daysLeft} days. Renew it.`);
      } catch (err) {
        log(`[https] WARNING: ${err.message}`);
      }
    }, 12 * 3600 * 1000);
    certTimer.unref?.();
  }
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 128 * 1024,
    // Refuse a client that reconnects over and over before it costs anything.
    verifyClient: (info, done) => (wsAllowed(addressOf(info.req)) ? done(true) : done(false, 429, 'Too Many Requests', { 'Retry-After': '60' }))
  });

  wss.on('connection', (ws) => {
    let peer = null;
    let alive = true;
    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
    const helloTimer = setTimeout(() => peer || ws.close(), 10_000);
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    let chain = Promise.resolve(); // handle one message at a time, in order
    ws.on('message', (raw) => {
      chain = chain.then(async () => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          if (!peer) {
            if (msg.type !== 'hello') throw new Error('Say hello first.');
            // Client check: only this project's client, on the same protocol, gets in.
            // The error codes tell the client to stop instead of trying again.
            if (msg.service !== SERVICE || msg.protocol !== PROTOCOL) {
              throw Object.assign(new Error('This client and this server are different versions. Update the client.'), { code: 'protocol' });
            }
            const claims = auth.verify(msg.token);
            if (claims?.role !== 'player') throw Object.assign(new Error('Your sign-in has expired. Sign in again.'), { code: 'auth' });
            if (authMode === 'dev') {
              // Testing mode: whitelisted SteamIDs only, and a small player limit.
              if (!store.get().testAccess.whitelist.includes(claims.sub)) {
                throw Object.assign(new Error("Your SteamID is not on this server's testing whitelist."), { code: 'denied' });
              }
              const others = [...hub.peers.values()].filter((p) => p.steamId !== claims.sub).length;
              if (others >= TEST_MODE_MAX_PLAYERS) {
                throw Object.assign(new Error(`This server is in testing mode, which allows ${TEST_MODE_MAX_PLAYERS} players, and it is full.`), { code: 'full' });
              }
            }
            peer = await hub.addPeer({ steamId: claims.sub, send, close: () => ws.close() });
            send({ replyTo: msg.id, ok: true, data: { routerRtpCapabilities: sfu.rtpCapabilities, serverName: config.name || APP_NAME } });
            send(hub.stateFor(peer));
            return;
          }
          const data = await hub.handle(peer, msg);
          if (msg.id != null) send({ replyTo: msg.id, ok: true, data });
        } catch (err) {
          if (msg.id != null) send({ replyTo: msg.id, ok: false, error: err.message, code: err.code });
          if (!peer) ws.close();
        }
      });
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(ping);
      if (peer) hub.removePeer(peer);
    });
    ws.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host || '0.0.0.0', resolve);
  });
  const port = server.address().port;
  if (!config.publicUrl) publicUrl = `${useTls ? 'https' : 'http'}://localhost:${port}`; // no address configured: use the port we actually got

  log(`${APP_NAME} ${VERSION_LABEL} is running.`);
  log(`  Admin panel:  ${publicUrl}/admin/`);
  if (hasWebClient) log(`  Web client:   ${publicUrl}/play/`);
  if (firstPassword) {
    log('');
    log(`  First run. Your admin password is:  ${firstPassword}`);
    log('  It is shown only this once. Change it in the admin panel under Server.');
    log('');
  }
  if (certificate) log(`  HTTPS: ${manualTls ? 'your certificate' : 'automatic certificate'} from ${certificate.info.issuer}, valid until ${new Date(certificate.info.validTo).toDateString()}.`);
  if (!useTls) log('  WARNING: no TLS certificate configured. Only use this behind an HTTPS reverse proxy or on localhost.');
  if (authMode === 'dev') log(`  WARNING: testing mode. Only whitelisted SteamIDs can join, up to ${TEST_MODE_MAX_PLAYERS} players, and a SteamID is not proven. Never use this for a public server.`);
  if (!config.rtc?.announcedAddress) log('  WARNING: rtc.announcedAddress is not set. Players outside this machine will not get audio.');

  return {
    port,
    hub,
    store,
    auth,
    firstPassword,
    async close() {
      clearInterval(certTimer);
      hub.stop();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
      sfu.close();
    }
  };
}
