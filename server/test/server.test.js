// End-to-end test of the real server and media relay with scripted clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { OP, rconCommand } from '../src/rcon.js';
import { startServer } from '../src/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `7656119800000000${n}`;

class Client {
  constructor(port) {
    this.port = port;
    this.events = [];
    this.pending = new Map();
    this.next = 1;
    this.state = null;
    this.hearing = new Set();
  }
  async connect(steamId) {
    const { token } = await (await fetch(`http://127.0.0.1:${this.port}/auth/dev?steamId=${steamId}`)).json();
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    await new Promise((res, rej) => this.ws.once('open', res).once('error', rej));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.replyTo != null) {
        const p = this.pending.get(m.replyTo);
        this.pending.delete(m.replyTo);
        return m.ok ? p.res(m.data) : p.rej(Object.assign(new Error(m.error), { code: m.code }));
      }
      if (m.type === 'state') this.state = m;
      if (m.type === 'newConsumer') this.hearing.add(m.peerId);
      if (m.type === 'consumerClosed') this.hearing.delete(m.peerId);
      this.events.push(m);
    });
    const hello = await this.req('hello', { token, service: 'species-voip', protocol: 1 });
    this.caps = hello.routerRtpCapabilities;
    return this;
  }
  req(type, body = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, type, ...body }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  /** Do what a real client does to start sending and receiving audio. */
  async media(ssrc) {
    await this.req('setCaps', { rtpCapabilities: this.caps });
    this.sendT = await this.req('createTransport', { direction: 'send' });
    this.recvT = await this.req('createTransport', { direction: 'recv' });
    await this.req('produce', {
      kind: 'audio',
      rtpParameters: {
        mid: '0',
        codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: {} }],
        encodings: [{ ssrc }]
      }
    });
  }
  get id() {
    return this.state.you.peerId;
  }
}

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isle-voip-'));
  const server = await startServer(
    { port: 0, host: '127.0.0.1', authMode: 'dev', dataDir, rtc: { listenIp: '127.0.0.1', port: 0 }, ...extra },
    { quiet: true }
  );
  // testing mode only lets whitelisted SteamIDs in
  server.store.update({ ...server.store.get(), testAccess: { whitelist: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(ID) } });
  return server;
}

test('routing follows species and group rules (manual species source)', async (t) => {
  const server = await boot();
  t.after(() => server.close());
  const [carnoA, carnoB, cera, stego, maia] = await Promise.all([1, 2, 3, 4, 5].map((n) => new Client(server.port).connect(ID(n))));

  // Nobody has a species yet: nobody can talk.
  assert.equal(carnoA.state.you.status, 'choose-species');
  await carnoA.req('declareSpecies', { speciesId: 'carnotaurus' });
  await carnoB.req('declareSpecies', { speciesId: 'carnotaurus' });
  await cera.req('declareSpecies', { speciesId: 'ceratosaurus' });
  await stego.req('declareSpecies', { speciesId: 'stegosaurus' });
  await maia.req('declareSpecies', { speciesId: 'maiasaura' });
  for (const c of [carnoA, carnoB, cera, stego, maia]) await c.media(1000 + Number(c.id.slice(0, 2), 16));
  await server.hub.sync();
  await sleep(50);
  for (const c of [carnoA, carnoB, cera, stego, maia]) assert.equal(c.hearing.size, 0, 'no groups yet, so silence');

  // Two carnos group up: they hear each other, nobody else does.
  await carnoA.req('groupCreate');
  const code = carnoA.state.group.code;
  assert.match(code, /^[A-Z0-9]{6}$/);
  await carnoB.req('groupJoin', { code });
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...carnoA.hearing], [carnoB.id]);
  assert.deepEqual([...carnoB.hearing], [carnoA.id]);
  assert.equal(cera.hearing.size + stego.hearing.size + maia.hearing.size, 0);

  // A different carnivore and a herbivore cannot join that group.
  await assert.rejects(cera.req('groupJoin', { code }), /can't join/);
  await assert.rejects(stego.req('groupJoin', { code }), /can't join/);
  await assert.rejects(cera.req('groupJoin', { code: 'ZZZZZZ' }), /No group/);

  // Mixed herbivores may share a group.
  await stego.req('groupCreate');
  await maia.req('groupJoin', { code: stego.state.group.code });
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...stego.hearing], [maia.id]);
  assert.deepEqual([...maia.hearing], [stego.id]);

  // carnoB dies and respawns as a stegosaurus: the species re-check removes
  // them from the carno group and cuts the audio both ways.
  await carnoB.req('declareSpecies', { speciesId: 'stegosaurus' });
  await server.hub.sync();
  await sleep(50);
  assert.equal(carnoB.state.group, null);
  assert.equal(carnoA.hearing.size, 0);
  assert.equal(carnoB.hearing.size, 0);
  assert.ok(carnoB.events.some((e) => e.type === 'notice' && /species changed/.test(e.text)));

  // Players are never told about people they cannot talk to, and no message
  // ever contains another player's SteamID.
  assert.deepEqual(carnoA.state.canTalkTo, []);
  const everything = JSON.stringify(carnoA.events);
  for (const n of [2, 3, 4, 5]) assert.ok(!everything.includes(ID(n)), 'no foreign SteamIDs');

  // Test-mode positions: stego and maia are grouped; move maia out of range and back.
  await stego.req('declarePosition', { x: 0, y: 0 });
  await maia.req('declarePosition', { x: 0, y: 400 });
  await server.hub.sync();
  await sleep(50);
  assert.equal(stego.hearing.size, 0);
  await maia.req('declarePosition', { x: 0, y: 20 });
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...stego.hearing], [maia.id]);

  // ICE candidates only ever point at the server.
  for (const cand of carnoA.recvT.iceCandidates) assert.equal(cand.address ?? cand.ip, '127.0.0.1');
});

test('admin API: login, settings change re-routes live, secrets are redacted', async (t) => {
  const server = await boot();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  assert.equal((await fetch(`${base}/api/admin/settings`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"wrong"}' })).status, 401);
  const { token } = await (
    await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: server.firstPassword }) })
  ).json();
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // a player token is not an admin token
  const player = await (await fetch(`${base}/auth/dev?steamId=${ID(1)}`)).json();
  assert.equal((await fetch(`${base}/api/admin/settings`, { headers: { authorization: `Bearer ${player.token}` } })).status, 401);

  const carno = await new Client(server.port).connect(ID(1));
  const cera = await new Client(server.port).connect(ID(2));
  await carno.req('declareSpecies', { speciesId: 'carnotaurus' });
  await cera.req('declareSpecies', { speciesId: 'ceratosaurus' });
  await carno.media(1);
  await cera.media(2);
  await server.hub.sync();
  assert.equal(carno.hearing.size, 0);

  // Provider opens carnivores up: any carnivore, no group needed.
  const settings = await (await fetch(`${base}/api/admin/settings`, { headers: h })).json();
  settings.categories.carnivore = { scope: 'category', requireGroup: false };
  settings.speciesSource.rcon.password = 'hunter2hunter2';
  settings.species.push({ name: 'Tyrannosaurus', category: 'carnivore', classNames: ['BP_Tyrannosaurus_C'] });
  const saved = await (await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: h, body: JSON.stringify(settings) })).json();
  assert.equal(saved.speciesSource.rcon.password, '', 'password never sent back');
  assert.equal(saved.speciesSource.rcon.hasPassword, true);
  assert.ok(saved.species.some((s) => s.id === 'tyrannosaurus'));
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...carno.hearing], [cera.id]);
  assert.deepEqual([...cera.hearing], [carno.id]);

  const status = await (await fetch(`${base}/api/admin/status`, { headers: h })).json();
  assert.equal(status.players.length, 2);
  assert.ok(!JSON.stringify(status).match(/\b\d+\.\d+\.\d+\.\d+\b/), 'no IP addresses in admin status');

  const bad = await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ ...settings, species: [{ name: 'X', category: 'rock' }] }) });
  assert.equal(bad.status, 400);
});

test('RCON species source: verified on join, re-checked, fails closed', async (t) => {
  // A fake Evrima RCON server.
  let players = `PlayerDataName: Jem, PlayerID: ${ID(1)}, Location: X=0 Y=0 Z=0, Class: BP_Carnotaurus_C, Growth: 1.0\nName: Sam, PlayerID: ${ID(2)}, Location: X=0 Y=0 Z=0, Class: BP_Carnotaurus_C, Growth: 1.0\n`;
  let up = true;
  const rcon = net.createServer((sock) => {
    if (!up) return sock.destroy();
    sock.once('data', (d) => {
      if (d[0] !== 0x01 || d.subarray(1, -1).toString() !== 'pw-pw-pw') return sock.end('Incorrect Password');
      sock.write('Password Accepted');
      sock.once('data', (c) => {
        assert.equal(c[0], 0x02);
        assert.equal(c[1], OP.playerData);
        sock.write(players);
      });
    });
  });
  await new Promise((r) => rcon.listen(0, '127.0.0.1', r));
  const rconPort = rcon.address().port;
  t.after(() => rcon.close());

  await assert.rejects(rconCommand({ host: '127.0.0.1', port: rconPort, password: 'nope' }, OP.playerData), /rejected the password/);

  const server = await boot();
  t.after(() => server.close());
  const st = structuredClone(server.store.get());
  st.speciesSource = { type: 'rcon', recheckSeconds: 5, rcon: { host: '127.0.0.1', port: rconPort, password: 'pw-pw-pw' }, legacy: { dir: '' } };
  server.store.update(st);

  const jem = await new Client(server.port).connect(ID(1));
  const sam = await new Client(server.port).connect(ID(2));
  const ghost = await new Client(server.port).connect(ID(3));
  assert.equal(jem.state.you.species.name, 'Carnotaurus');
  assert.equal(jem.state.you.name, 'Jem');
  assert.equal(ghost.state.you.status, 'not-spawned');
  await assert.rejects(jem.req('declareSpecies', { speciesId: 'stegosaurus' }), /automatically/, 'cannot self-declare when RCON is the source');
  await assert.rejects(ghost.req('groupCreate'), /Spawn in/);

  await jem.media(1);
  await sam.media(2);
  await jem.req('groupCreate');
  await sam.req('groupJoin', { code: jem.state.group.code });
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...jem.hearing], [sam.id]);

  // Proximity: Sam walks 150 m away (range is 100 m) and the audio is cut both ways...
  const samAt = (x) => (players = players.replace(new RegExp(`${ID(2)}, Location: X=[-\\d.]+`), `${ID(2)}, Location: X=${x}`));
  samAt(15000);
  await server.hub.refreshSpecies();
  await server.hub.sync();
  await sleep(50);
  assert.equal(jem.hearing.size, 0, 'out of range');
  assert.equal(sam.hearing.size, 0);
  assert.equal(jem.state.group.members.length, 2, 'still in the same voice group');
  assert.deepEqual(jem.state.canTalkTo, []);
  assert.equal(jem.state.proximity.rangeMetres, 100);
  // ...walks back to 80 m and it returns, quieter because of the distance.
  samAt(8000);
  await server.hub.refreshSpecies();
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...jem.hearing], [sam.id]);
  assert.equal(jem.state.canTalkTo[0].gain, 0.5);
  // At 105 m an open stream is held (no cutting in and out at the edge); at 120 m it goes.
  samAt(10500);
  await server.hub.refreshSpecies();
  await server.hub.sync();
  await sleep(50);
  assert.equal(jem.hearing.size, 1);
  samAt(12000);
  await server.hub.refreshSpecies();
  await server.hub.sync();
  await sleep(50);
  assert.equal(jem.hearing.size, 0);
  // The operator widens the range to 300 m: applies immediately.
  const wide = structuredClone(server.store.get());
  wide.proximity.rangeMetres = 300;
  server.store.update(wide);
  server.hub.onSettingsChanged();
  await server.hub.sync();
  await sleep(50);
  assert.deepEqual([...jem.hearing], [sam.id]);
  assert.deepEqual(server.hub.adminStatus().players.find((p) => p.name === 'Sam').pos, { x: 120, y: 0, z: 0 });

  // Sam respawns as an unlisted species: caught on the next check.
  players = players.replace(/(Name: Sam.*)BP_Carnotaurus_C/, '$1BP_Triceratops_C');
  await server.hub.refreshSpecies();
  await server.hub.sync();
  await sleep(50);
  assert.equal(sam.state.you.status, 'unknown-species');
  assert.equal(jem.hearing.size, 0);
  assert.deepEqual(server.hub.adminStatus().unknownClasses, ['BP_Triceratops_C']);

  // RCON goes down: a brand-new player stays silent rather than being trusted.
  up = false;
  const late = await new Client(server.port).connect(ID(4));
  assert.equal(late.state.you.status, 'source-down');
  assert.equal(late.state.you.species, null);
});

test('service check: clients can recognise the service, and both sides refuse a mismatch or a flood', async (t) => {
  const server = await boot({ limits: { connectionsPerMinute: 4, httpPerMinute: 8 } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const open = () => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    ws.once('open', () => res(ws)).once('unexpected-response', (_r, resp) => res(resp.statusCode)).once('error', () => res('error'));
  });
  const ask = (ws, body) => new Promise((res) => { ws.once('message', (raw) => res(JSON.parse(raw))); ws.send(JSON.stringify({ id: 1, ...body })); });

  // 1. the marker a client looks for before it connects
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.service, 'species-voip');
  assert.equal(info.protocol, 1);
  assert.match(info.versionLabel, /^v\d+\.\d+\.\d+/);
  const { token } = await (await fetch(`${base}/auth/dev?steamId=${ID(1)}`)).json();

  // 2. a client on another protocol, or something that is not our client, is told to stop
  let ws = await open();
  let reply = await ask(ws, { type: 'hello', token, service: 'species-voip', protocol: 99 });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'protocol');
  ws = await open();
  reply = await ask(ws, { type: 'hello', token });
  assert.equal(reply.code, 'protocol');

  // 3. an expired or forged sign-in is told to sign in again, not to retry
  ws = await open();
  reply = await ask(ws, { type: 'hello', token: 'nope', service: 'species-voip', protocol: 1 });
  assert.equal(reply.code, 'auth');

  // 4. a client that hammers the server is refused before anything is set up
  assert.equal(typeof (await open()), 'object', '4th connection in a minute is still allowed');
  assert.equal(await open(), 429, '5th is refused');
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await fetch(`${base}/api/info`)).status);
  assert.ok(statuses.includes(429), 'repeated checks are slowed down too');
  assert.equal(server.hub.peers.size, 0, 'none of that left anything behind');
});

test('first-run setup: local only, needs its key, writes a working config', async (t) => {
  const { startSetup, buildConfig } = await import('../src/setup.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const configFile = path.join(dir, 'config.json');
  let finished = null;
  const setup = await startSetup({ configFile, dataDir: path.join(dir, 'data'), log: () => {}, onDone: (c) => (finished = c) });
  t.after(() => setup.close());
  const base = `http://127.0.0.1:${setup.port}`;
  const post = (body, key = setup.key) => fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-key': key }, body: JSON.stringify(body) });

  // while in setup it does not look like the voice service, so clients stay quiet
  assert.equal((await (await fetch(`${base}/api/info`)).json()).service, undefined);
  assert.equal((await fetch(`${base}/setup/`)).status, 200);
  // wrong or missing key is refused
  assert.equal((await post({ mode: 'test', password: 'long-enough-pw' }, 'wrong')).status, 403);
  // bad answers get a readable message and write nothing
  let r = await post({ mode: 'test', password: 'short' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /10 characters/);
  r = await post({ mode: 'certificate', address: 'voice.example.com', publicIp: '203.0.113.10', cert: '/nope.pem', key: '/nope.key', password: 'long-enough-pw' });
  assert.match((await r.json()).error, /Can't read the certificate/);
  assert.equal(fs.existsSync(configFile), false);

  // form -> config
  assert.deepEqual(buildConfig({ mode: 'proxy', address: 'https://voice.example.com/', publicIp: '203.0.113.10', port: 7777, publicPort: 443, name: 'Rex' }), {
    name: 'Rex', port: 7777, publicUrl: 'https://voice.example.com', tls: { cert: '', key: '' },
    rtc: { announcedAddress: '203.0.113.10', port: 40000 }, authMode: 'steam', trustProxy: 1
  });
  assert.throws(() => buildConfig({ mode: 'proxy', address: 'nodots', publicIp: '203.0.113.10' }), /voice address/);
  assert.throws(() => buildConfig({ mode: 'proxy', address: 'voice.example.com', publicIp: 'banana' }), /public IP/);
  assert.throws(() => buildConfig({ mode: 'test', port: 99999 }), /voice port/);
  // automatic HTTPS needs the Let's Encrypt terms to be accepted
  const auto = { mode: 'auto', address: 'voice.example.com', publicIp: '203.0.113.10' };
  assert.throws(() => buildConfig(auto), /Subscriber Agreement/);
  assert.deepEqual(buildConfig({ ...auto, agree: true, email: 'me@example.com' }).tls, { cert: '', key: '', auto: { agreedToTerms: true, email: 'me@example.com' } });
  assert.equal(buildConfig({ ...auto, agree: true }).publicUrl, 'https://voice.example.com:7777');
  // "I have a certificate" with nothing chosen points at the automatic option
  assert.throws(() => buildConfig({ mode: 'certificate', address: 'voice.example.com', publicIp: '203.0.113.10' }), /free certificate automatically/);

  // a good answer writes the config, sets the admin password, and hands over
  r = await post({ mode: 'test', name: 'Test Isle', port: 18555, audioPort: 40222, password: 'long-enough-pw' });
  assert.match((await r.json()).error, /needs a whitelist/, 'testing mode is refused without a whitelist');
  r = await post({ mode: 'test', name: 'Test Isle', port: 18555, audioPort: 40222, password: 'long-enough-pw', whitelist: `${ID(1)}\n${ID(2)}, not-an-id` });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.localUrl, 'http://localhost:18555/admin/');
  await sleep(600);
  assert.equal(finished.authMode, 'dev');
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.publicUrl, 'http://localhost:18555');

  // the voice server starts from that config and the chosen password works
  const server = await startServer({ ...saved, host: '127.0.0.1', dataDir: path.join(dir, 'data'), rtc: { ...saved.rtc, listenIp: '127.0.0.1' } }, { quiet: true });
  t.after(() => server.close());
  assert.equal(server.firstPassword, null, 'no random password: the one from setup is used');
  const login = await fetch(`http://127.0.0.1:${server.port}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'long-enough-pw' }) });
  assert.equal(login.status, 200);

  // testing mode: only the whitelisted SteamIDs get in
  assert.deepEqual(server.store.get().testAccess.whitelist, [ID(1), ID(2)]);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/auth/dev?steamId=${ID(1)}`)).status, 200);
  const refused = await fetch(`http://127.0.0.1:${server.port}/auth/dev?steamId=${ID(3)}`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /whitelist/);
  // a token made before being removed from the whitelist stops working too
  const { token } = await (await fetch(`http://127.0.0.1:${server.port}/auth/dev?steamId=${ID(2)}`)).json();
  server.store.update({ ...server.store.get(), testAccess: { whitelist: [ID(1)] } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((res) => ws.once('open', res));
  const reply = await new Promise((res) => { ws.once('message', (raw) => res(JSON.parse(raw))); ws.send(JSON.stringify({ id: 1, type: 'hello', token, service: 'species-voip', protocol: 1 })); });
  assert.equal(reply.code, 'denied');
  // the whitelist can never hold more than 30 players
  const many = Array.from({ length: 40 }, (_, i) => `765611980000001${String(i).padStart(2, '0')}`);
  assert.equal(server.store.update({ ...server.store.get(), testAccess: { whitelist: many } }).testAccess.whitelist.length, 30);
});

test('certificates: only ones from a trusted authority, for the right address, in date, with the right key', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { inspectCertificate } = await import('../src/certs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-'));
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  // A stand-in certificate authority with an intermediate, like real ones have.
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '30', '-subj', '/O=Test Trusted Root/CN=Test Root');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/O=Test Issuing CA/CN=Test Intermediate');
  fs.writeFileSync(path.join(dir, 'int.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.pem', '-days', '30', '-extfile', 'int.ext');
  const leaf = (name, host, days = '20') => {
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${host}`);
    fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${host}\n`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', days, '-extfile', `${name}.ext`);
  };
  leaf('good', 'voice.example.com');
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.pem', '-days', '30', '-subj', '/CN=voice.example.com', '-addext', 'subjectAltName=DNS:voice.example.com');
  const trusted = [read('root.pem')];
  const fullchain = read('good.pem') + read('int.pem');
  const check = (o) => inspectCertificate({ host: 'voice.example.com', extraRoots: trusted, ...o });

  const ok = check({ certPem: fullchain, keyPem: read('good.key') });
  assert.equal(ok.issuer, 'Test Issuing CA');
  assert.ok(ok.daysLeft >= 18 && ok.daysLeft <= 20);

  assert.throws(() => check({ certPem: read('self.pem'), keyPem: read('self.key') }), /self-signed/, 'self-signed is refused');
  assert.throws(() => inspectCertificate({ certPem: fullchain, keyPem: read('good.key'), host: 'voice.example.com' }), /not a publicly trusted certificate authority/, 'a private authority is refused');
  assert.throws(() => check({ certPem: read('good.pem'), keyPem: read('good.key') }), /full chain/, 'missing intermediate is explained');
  assert.throws(() => check({ certPem: fullchain, keyPem: read('good.key'), host: 'other.example.com' }), /different address/);
  assert.throws(() => check({ certPem: fullchain, keyPem: read('self.key') }), /does not belong/);
  assert.throws(() => check({ certPem: fullchain, keyPem: read('good.key'), now: Date.now() + 40 * 24 * 3600 * 1000 }), /expired/);
  assert.throws(() => check({ certPem: 'hello', keyPem: read('good.key') }), /does not contain a certificate/);

  // Automatic HTTPS, the parts that can be checked without a real certificate authority:
  const { ensureAutoCertificate } = await import('../src/certs.js');
  const autoDir = path.join(dir, 'auto');
  fs.mkdirSync(autoDir);
  const dead = 'https://127.0.0.1:1/dir'; // nothing listens here
  // a saved certificate with plenty of life left is used as it is: the authority is not contacted
  fs.writeFileSync(path.join(autoDir, 'voice.example.com.fullchain.pem'), fullchain);
  fs.writeFileSync(path.join(autoDir, 'voice.example.com.key.pem'), read('good.key'));
  const kept = await ensureAutoCertificate({ dir: autoDir, host: 'voice.example.com', extraRoots: trusted, directoryUrl: dead, challengePort: 0 });
  assert.equal(kept.renewed, false);
  assert.equal(kept.info.issuer, 'Test Issuing CA');
  // one with under a third of its life left triggers a renewal attempt, and a failure is explained
  leaf('old', 'old.example.com', '1');
  fs.writeFileSync(path.join(autoDir, 'old.example.com.fullchain.pem'), read('old.pem') + read('int.pem'));
  fs.writeFileSync(path.join(autoDir, 'old.example.com.key.pem'), read('old.key'));
  const realNow = Date.now;
  Date.now = () => realNow() + 20 * 3600 * 1000; // 20 hours later: 4 hours of a 24-hour certificate left
  try {
    await assert.rejects(ensureAutoCertificate({ dir: autoDir, host: 'old.example.com', extraRoots: trusted, directoryUrl: dead, challengePort: 0 }), /Could not get a certificate for old\.example\.com\. Check that the address points at this server/);
  } finally {
    Date.now = realNow;
  }
  // the port it needs being taken is explained too
  const blocker = net.createServer().listen(0);
  await new Promise((r) => blocker.once('listening', r));
  await assert.rejects(ensureAutoCertificate({ dir: autoDir, host: 'new.example.com', directoryUrl: dead, challengePort: blocker.address().port }), /is being used by another program/);
  blocker.close();

  // The server refuses to start with a certificate players would not trust...
  const cfg = (cert, key) => ({ port: 0, host: '127.0.0.1', publicUrl: 'https://voice.example.com:7777', authMode: 'steam', dataDir: path.join(dir, 'data'), tls: { cert: path.join(dir, cert), key: path.join(dir, key) }, rtc: { listenIp: '127.0.0.1', port: 40444 } });
  await assert.rejects(startServer(cfg('self.pem', 'self.key'), { quiet: true }), /self-signed/);
  // ...and starts over HTTPS with a good one, reporting it to the admin panel.
  fs.writeFileSync(path.join(dir, 'fullchain.pem'), fullchain);
  const server = await startServer(cfg('fullchain.pem', 'good.key'), { quiet: true, extraTrustedRoots: trusted });
  t.after(() => server.close());
  const https = await import('node:https');
  const body = await new Promise((res, rej) => https.get({ host: '127.0.0.1', port: server.port, path: '/api/info', servername: 'voice.example.com', ca: trusted }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
  assert.equal(body.service, 'species-voip');
});
