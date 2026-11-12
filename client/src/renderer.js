// Species Specific VoIP (The Isle Evrima) player client. Runs inside the desktop app, and also as a
// plain web page (without global push-to-talk or the call key).
import { Device } from 'mediasoup-client';

const desktop = window.isleDesktop || null;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// uiohook key codes for the desktop defaults
const KEY_F = 33;

const DEFAULTS = {
  server: '',
  mode: 'ptt', // ptt | voice
  // F is also the game's own call key, so holding it to talk makes your dinosaur call,
  // the way the game's built-in voice chat does. Change it under Settings.
  pttKey: desktop ? { kind: 'key', code: KEY_F, name: 'F' } : { kind: 'web', code: 'KeyF', name: 'F' },
  threshold: 35,
  callEnabled: false, // off until a player turns it on: see the warning beside the setting
  callKey: { kind: 'key', code: KEY_F, name: 'F' },
  cooldown: 3,
  mic: '',
  recentServers: [],
  staySignedIn: true,
  volumes: {}
};
let cfg = { ...DEFAULTS };

async function loadConfig() {
  let stored = {};
  try {
    stored = desktop ? await desktop.getConfig() : JSON.parse(localStorage.getItem('isleVoipClient') || '{}');
  } catch {}
  cfg = { ...DEFAULTS, ...stored };
}
function saveConfig() {
  try {
    if (desktop) desktop.setConfig(cfg);
    else localStorage.setItem('isleVoipClient', JSON.stringify(cfg));
  } catch {}
}

// ---- connection state --------------------------------------------------------

let ws = null;
let token = null;
let serverUrl = '';
let nextId = 1;
const pending = new Map();
let device = null;
let sendTransport = null;
let recvTransport = null;
let producer = null;
let micStream = null;
let meterTimer = null;
let audioCtx = null;
let state = null; // latest state message from the server
const consumers = new Map(); // peerId -> { consumer, audio }
const speaking = new Set(); // peerIds currently talking
let talking = false;
let muted = false;
let pttHeld = false;
let voiceOpen = false;
let lastCall = 0;
let wantConnected = false;

function request(type, body = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected.'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, ...body }));
  });
}

function notice(text, level = 'warn') {
  const box = document.createElement('div');
  box.className = 'notice' + (level === 'error' ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = text;
  const close = document.createElement('button');
  close.className = 'btn quiet';
  close.textContent = 'Dismiss';
  close.onclick = () => box.remove();
  box.append(span, close);
  $('#notices').append(box);
  while ($('#notices').children.length > 3) $('#notices').firstChild.remove();
}

// ---- finding the voice service, quietly ---------------------------------------
//
// The client never assumes a voice server is there. Before it connects it asks
// the address one small question (GET /api/info) and looks for this project's
// marker. If the service is not running it stays silent: nothing pops up,
// nothing takes focus, no keys are pressed and the microphone stays closed.
// It checks again a few times, further and further apart, then stops and
// waits for you, so it never hammers a server that is not running the service.

const SERVICE = 'species-voip';
const PROTOCOL = 1;
const RETRY_DELAYS = [10, 30, 60, 120, 300, 600, 600, 600]; // seconds between checks, then it stops
const WHY = {
  unreachable: "Can't reach that address.",
  'not-voip': 'No voice service is running at that address.',
  busy: 'The voice server asked us to slow down.',
  lost: 'The connection to the voice server was lost.'
};

let attempt = 0; // how many automatic checks have been made in a row
let retryTimer = null;
let connecting = false;
let serverInfo = null;

// The voice service is assumed to be on the same port number as the game
// server (7777 unless the host changed it). The game uses that number over
// UDP and the voice service uses it over TCP, so the two do not clash.
const DEFAULT_PORT = 7777;

/**
 * Turn what the player typed into the server's address.
 * "voice.example.com" with the port left empty -> https://voice.example.com:7777
 * A port typed as part of the address ("voice.example.com:9000") wins over the port box.
 */
function buildServerUrl(address, port) {
  let text = String(address || '').trim();
  if (!text) throw new Error('empty');
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  const url = new URL(text);
  const portInAddress = /:\d+$/.test(text.replace(/^https?:\/\//i, '').split('/')[0]);
  if (!portInAddress) {
    const typed = String(port ?? '').trim();
    const n = typed ? Number(typed) : DEFAULT_PORT;
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port');
    url.port = String(n);
  }
  return url.origin;
}

/** Split a saved address back into the two boxes. */
function splitServerUrl(origin) {
  try {
    const url = new URL(origin);
    const address = url.protocol === 'https:' ? url.hostname : `${url.protocol}//${url.hostname}`;
    return { address, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
  } catch {
    return { address: '', port: '' };
  }
}

function fillServerFields() {
  const { address, port } = splitServerUrl(serverUrl || cfg.server);
  for (const [a, b] of [['#server', '#port'], ['#set-server', '#set-port']]) {
    $(a).value = address;
    $(b).value = port;
  }
  $('#current-server').textContent = serverUrl ? serverUrl.replace(/^https:\/\//, '') : '';
  const list = $('#recent-servers');
  list.textContent = '';
  for (const url of cfg.recentServers || []) list.append(new Option(url.replace(/^https:\/\//, '')));
}

function rememberServer(url) {
  cfg.server = url;
  cfg.recentServers = [url, ...(cfg.recentServers || []).filter((u) => u !== url)].slice(0, 5);
  saveConfig();
  fillServerFields();
}

/** Leave the current server (if any) and go to another one. Used by the sign-in form and by Settings. */
async function useServer(url) {
  wantConnected = false;
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    if (ws.readyState <= WebSocket.OPEN) ws.close();
  }
  teardown();
  if (url !== serverUrl) token = desktop && cfg.staySignedIn ? await desktop.loadSession(url) : null; // a sign-in only counts for the server it was made on
  serverUrl = url;
  rememberServer(url);
  attempt = 0;
  await goOnline(true);
}

/** One small request that tells us whether this project's voice service is at the address. */
async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let res;
  try {
    res = await fetch(url + '/api/info', { signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) return { ok: false, reason: 'busy' };
  let info = null;
  try {
    info = res.ok ? await res.json() : null;
  } catch {}
  if (!info || info.service !== SERVICE) return { ok: false, reason: 'not-voip' };
  if (info.protocol !== PROTOCOL) return { ok: false, reason: 'protocol', info };
  return { ok: true, info };
}

/**
 * Check for the service and connect if it is there.
 * interactive = the player just pressed a button, so it is fine to open the
 * Steam sign-in window. Automatic checks never open anything.
 */
async function goOnline(interactive = false) {
  clearTimeout(retryTimer);
  wantConnected = true;
  showWaiting('Checking for the voice service…');
  const found = await probe(serverUrl);
  if (!wantConnected) return;
  if (!found.ok) {
    if (found.reason === 'protocol') {
      return stopOnline(`That server runs a different version of the voice service (${found.info.versionLabel || 'unknown'}). This client is ${__APP_VERSION__}. Update so they match.`);
    }
    return scheduleRetry(found.reason);
  }
  serverInfo = found.info;
  $('#server-name').textContent = serverInfo.name;

  if (!token) {
    if (!interactive) return needSignIn();
    try {
      token = await getToken();
    } catch (e) {
      return needSignIn(e.message);
    }
    if (!token) return; // waiting for the SteamID field, or the browser went to Steam
    if (desktop && cfg.staySignedIn) desktop.saveSession(serverUrl, token);
  }

  connecting = true;
  try {
    await connect();
    attempt = 0;
  } catch (e) {
    if (ws) {
      ws.onclose = null; // this failure is handled here, once
      if (ws.readyState <= WebSocket.OPEN) ws.close();
    }
    teardown();
    if (!wantConnected) return;
    if (e.code === 'auth') {
      token = null;
      desktop?.clearSession(serverUrl);
      return needSignIn('Your sign-in has expired. Sign in again.');
    }
    if (['protocol', 'full', 'denied'].includes(e.code)) return stopOnline(e.message); // the server said no: don't keep asking
    scheduleRetry('unreachable');
  } finally {
    connecting = false;
  }
}

/** Get a sign-in token. Only ever called after the player presses the button. */
async function getToken() {
  if (serverInfo.authMode === 'dev') {
    const field = $('#dev-field');
    if (field.hidden) {
      needSignIn();
      field.hidden = false;
      $('#connect-btn').textContent = 'Connect';
      $('#steamid').focus();
      return null;
    }
    const res = await fetch(`${serverUrl}/auth/dev?steamId=${encodeURIComponent($('#steamid').value.trim())}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.token;
  }
  if (desktop) return desktop.steamLogin(serverUrl);
  location.href = serverUrl + '/auth/steam'; // comes back via /auth-done.html
  return null;
}

function scheduleRetry(reason) {
  clearTimeout(retryTimer);
  if (attempt >= RETRY_DELAYS.length) {
    return stopOnline(`${WHY[reason]} Stopped checking, so the server isn't bothered. Press "Check for voice service" once it is running.`);
  }
  const seconds = Math.round(RETRY_DELAYS[attempt] * (0.85 + Math.random() * 0.3)); // a little randomness so clients don't all check at once
  attempt++;
  const when = seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
  showWaiting(`${WHY[reason]} Voice stays off and your game is not affected. Checking again in ${when} (check ${attempt} of ${RETRY_DELAYS.length}).`);
  retryTimer = setTimeout(() => wantConnected && goOnline(), seconds * 1000);
}

/** Give up for now and wait for the player. */
function stopOnline(message) {
  wantConnected = false;
  clearTimeout(retryTimer);
  attempt = 0;
  showConnect(message);
}

function needSignIn(message) {
  wantConnected = false;
  clearTimeout(retryTimer);
  showConnect(message);
}

const BAD_ADDRESS = "That address doesn't look right. Type the server's address, like voice.example.com, and its port.";

async function signIn(ev) {
  ev?.preventDefault();
  $('#connect-err').hidden = true;
  let url;
  try {
    url = desktop ? buildServerUrl($('#server').value, $('#port').value) : location.origin;
  } catch {
    return showConnect(BAD_ADDRESS);
  }
  if (url === serverUrl) {
    // same server: keep the sign-in we already have
    attempt = 0;
    return goOnline(true);
  }
  await useServer(url);
}

// ---- voice connection --------------------------------------------------------

async function connect() {
  ws = new WebSocket(serverUrl.replace(/^http/, 'ws') + '/ws');
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = onClose;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Can't reach the voice server."));
  });
  // Server check: say who we are; the server refuses a client it doesn't match.
  const hello = await request('hello', { token, service: SERVICE, protocol: PROTOCOL, version: __APP_VERSION__ });
  $('#server-name').textContent = hello.serverName;
  $('#connect').hidden = true;
  $('#app').hidden = false;
  setConn('Connecting…');

  device = new Device();
  await device.load({ routerRtpCapabilities: hello.routerRtpCapabilities });
  await request('setCaps', { rtpCapabilities: device.rtpCapabilities });

  recvTransport = device.createRecvTransport(await request('createTransport', { direction: 'recv' }));
  recvTransport.on('connect', ({ dtlsParameters }, ok, fail) => request('connectTransport', { direction: 'recv', dtlsParameters }).then(ok, fail));

  sendTransport = device.createSendTransport(await request('createTransport', { direction: 'send' }));
  sendTransport.on('connect', ({ dtlsParameters }, ok, fail) => request('connectTransport', { direction: 'send', dtlsParameters }).then(ok, fail));
  sendTransport.on('produce', ({ kind, rtpParameters }, ok, fail) => request('produce', { kind, rtpParameters }).then(ok, fail));

  await startMic();
  setConn('Connected');
  showSecurity();
  $('#notices').textContent = ''; // messages from an earlier connection no longer apply
  fillServerFields();
}

async function startMic() {
  try {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: cfg.mic ? { exact: cfg.mic } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    if (cfg.mic) {
      cfg.mic = '';
      return startMic(); // the saved device is gone: fall back to the default one
    }
    notice('No microphone available. You can listen but not talk. Check your microphone and its permission, then reconnect.', 'error');
    return;
  }
  const track = micStream.getAudioTracks()[0];
  if (producer) await producer.replaceTrack({ track });
  else {
    producer = await sendTransport.produce({ track, codecOptions: { opusDtx: true, opusFec: true }, stopTracks: false });
    producer.pause(); // nothing is sent until you talk
  }
  startMeter();
  listMics();
}

async function listMics() {
  const sel = $('#mic');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  sel.textContent = '';
  for (const d of devices) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Microphone';
    sel.append(o);
  }
  const current = micStream?.getAudioTracks()[0]?.getSettings().deviceId;
  if (current) sel.value = current;
}

// Measures how loud the microphone is, for the level meter and voice activation.
let meterTrack = null;
function startMeter() {
  clearInterval(meterTimer);
  meterTrack?.stop();
  audioCtx?.close();
  audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  // Analyse a copy, so the meter keeps working while the sent track is paused.
  const copy = micStream.getAudioTracks()[0].clone();
  meterTrack = copy;
  copy.enabled = true; // pausing the sender disables the original track, and a clone inherits that
  audioCtx.createMediaStreamSource(new MediaStream([copy])).connect(analyser);
  audioCtx.resume().catch(() => {});
  const buf = new Float32Array(analyser.fftSize);
  let lastLoud = 0;
  meterTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
    const level = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)); // -60 dB..0 dB -> 0..100
    const over = level > cfg.threshold;
    const bar = $('#level');
    bar.style.width = level + '%';
    bar.classList.toggle('over', over);
    if (over) lastLoud = Date.now();
    voiceOpen = Date.now() - lastLoud < 400; // keep sending through short pauses
    updateTalking();
  }, 50);
}

function canTalkNow() {
  return Boolean(producer && state?.you.species && !muted);
}

function updateTalking() {
  const want = canTalkNow() && (cfg.mode === 'ptt' ? pttHeld : voiceOpen);
  if (want === talking) return;
  talking = want;
  if (producer) want ? producer.resume() : producer.pause();
  request('speaking', { on: want }).catch(() => {});
  $('#you').classList.toggle('talking', want);
  if (want) pressCallKey();
}

// Press the in-game call key when talking starts, like the game's own voice chat.
function pressCallKey() {
  if (!desktop || !state?.callMacro.enabled || !cfg.callEnabled) return;
  // If push-to-talk already IS the call key, the game has received the press itself.
  if (cfg.mode === 'ptt' && cfg.pttKey.kind === 'key' && cfg.pttKey.code === cfg.callKey.code) return;
  const now = Date.now();
  if (now - lastCall < cfg.cooldown * 1000) return;
  lastCall = now;
  desktop.tapKey(cfg.callKey.code);
}

// ---- messages from the server ---------------------------------------------------

async function onMessage(msg) {
  if (msg.replyTo != null) {
    const p = pending.get(msg.replyTo);
    pending.delete(msg.replyTo);
    if (p) msg.ok ? p.resolve(msg.data) : p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
    return;
  }
  if (msg.type === 'state') {
    state = msg;
    for (const [id, c] of consumers) c.audio.volume = volumeFor(id);
    render();
    updateTalking();
  } else if (msg.type === 'notice') {
    notice(msg.text, msg.level);
  } else if (msg.type === 'newConsumer') {
    try {
      const consumer = await recvTransport.consume({ id: msg.consumerId, producerId: msg.producerId, kind: msg.kind, rtpParameters: msg.rtpParameters });
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = new MediaStream([consumer.track]);
      audio.volume = volumeFor(msg.peerId);
      $('#audio').append(audio);
      consumers.set(msg.peerId, { consumer, audio });
      await request('resumeConsumer', { consumerId: msg.consumerId });
      audio.play().catch(() => {});
    } catch (e) {
      console.warn('Could not start a voice stream', e);
    }
  } else if (msg.type === 'consumerClosed') {
    dropConsumer(msg.peerId);
    speaking.delete(msg.peerId);
    render();
  } else if (msg.type === 'speaking') {
    msg.on ? speaking.add(msg.peerId) : speaking.delete(msg.peerId);
    render();
  }
}

// Your own volume setting for a player, times the server's fade for distance.
function volumeFor(peerId) {
  const gain = state?.canTalkTo.find((p) => p.peerId === peerId)?.gain ?? 1;
  return Math.max(0, Math.min(1, (cfg.volumes[peerId] ?? 1) * gain));
}

function dropConsumer(peerId) {
  const c = consumers.get(peerId);
  if (!c) return;
  c.consumer.close();
  c.audio.remove();
  consumers.delete(peerId);
}

function teardown() {
  clearInterval(meterTimer);
  meterTrack?.stop();
  audioCtx?.close();
  audioCtx = null;
  for (const id of [...consumers.keys()]) dropConsumer(id);
  speaking.clear();
  sendTransport?.close();
  recvTransport?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  sendTransport = recvTransport = producer = micStream = device = null;
  for (const p of pending.values()) p.reject(new Error('Disconnected.'));
  pending.clear();
  talking = false;
  state = null;
}

function onClose() {
  if (connecting) return; // goOnline() is already dealing with this failure
  teardown();
  if (!wantConnected) return showConnect();
  // The server went away mid-session. Go quiet and check for it, a limited number of times.
  scheduleRetry('lost');
}

/** The sign-in form, optionally with a message. */
function showConnect(message) {
  $('#app').hidden = true;
  $('#connect').hidden = false;
  $('#wait').hidden = true;
  $('#connect-form').hidden = false;
  $('#signout').hidden = !token;
  $('#connect-btn').textContent = token ? 'Check for voice service' : !$('#dev-field').hidden ? 'Connect' : 'Sign in with Steam';
  const err = $('#connect-err');
  err.hidden = !message;
  if (message) err.textContent = message;
}

/** The quiet waiting panel shown while checking, or between checks. */
function showWaiting(text) {
  $('#app').hidden = true;
  $('#connect').hidden = false;
  $('#connect-form').hidden = true;
  $('#wait').hidden = false;
  $('#wait-text').textContent = text;
}

/**
 * Say plainly whether the connection is secure. It is secure only when the
 * server is reached over HTTPS; anything else is shown as not secure, in the
 * header and in a banner that stays for as long as you are connected.
 */
function showSecurity() {
  const secure = serverUrl.startsWith('https://');
  const testing = serverInfo?.authMode === 'dev';
  const badge = $('#security');
  badge.hidden = false;
  badge.textContent = secure ? 'Secure' : 'Not secure';
  badge.classList.toggle('bad', !secure);
  badge.title = secure ? 'Sign-in and signalling are encrypted with HTTPS, and audio is encrypted too.' : 'This connection does not use HTTPS.';
  const warn = [];
  if (!secure) warn.push('This connection is not secure: the server is not using HTTPS, so sign-in and signalling are not encrypted. Only use it for testing on your own computer.');
  if (testing) warn.push('This server is in testing mode, so players\' identities are not verified.');
  const banner = $('#insecure');
  banner.hidden = warn.length === 0;
  banner.textContent = warn.join(' ');
}

function setConn(text) {
  $('#conn').textContent = text;
}

// ---- drawing the page ------------------------------------------------------------

const SCOPE = { species: 'other {s} only', category: 'any {c}', all: 'any species' };
const STATUS = {
  'not-spawned': ['Not spawned yet', 'Spawn in the game. Your species is checked automatically, and voice turns on once you are alive.'],
  'unknown-species': ['Species not set up', "This server hasn't added your species to its voice rules yet. Ask the server's admins."],
  'source-down': ["Can't check your species", "The voice server can't reach the game server right now. Voice stays off until it can."],
  'choose-species': ['Pick your species', 'This server is in test mode, so you choose your own species below.']
};

function person(p, { withVolume }) {
  const li = document.createElement('li');
  if (speaking.has(p.peerId)) li.className = 'speaking';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('span');
  name.textContent = p.name + (p.you ? ' (you)' : '');
  const sp = document.createElement('span');
  sp.className = 'muted small';
  sp.textContent = p.species;
  who.append(name, sp);
  li.append(dot, who);
  if (withVolume) {
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = 0;
    vol.max = 100;
    vol.value = Math.round((cfg.volumes[p.peerId] ?? 1) * 100);
    vol.setAttribute('aria-label', `Volume for ${p.name}`);
    vol.oninput = () => {
      cfg.volumes[p.peerId] = vol.value / 100;
      const c = consumers.get(p.peerId);
      if (c) c.audio.volume = volumeFor(p.peerId);
    };
    li.append(vol);
  }
  return li;
}

function render() {
  if (!state) return;
  const you = state.you;
  const youBox = $('#you');
  youBox.className = 'you' + (you.species ? ' ' + you.species.category : '') + (talking ? ' talking' : '') + (muted ? ' muted-mic' : '');

  if (you.species) {
    $('#species').textContent = you.species.name;
    const scope = SCOPE[state.rule.scope].replace('{s}', you.species.name).replace('{c}', you.species.category);
    const near = state.proximity ? ` within ${state.proximity.rangeMetres} m of you` : '';
    $('#rule').textContent = `You can talk to ${scope}${near}${state.rule.requireGroup ? ', once you share a voice group.' : '. No group needed.'}`;
    const how = cfg.mode === 'ptt' ? `Hold ${cfg.pttKey.name} to talk.` : 'Just talk. Your microphone opens when you speak.';
    const lost = state.proximity && !state.proximity.located;
    $('#talk-hint').textContent = lost ? "The game hasn't reported your position yet, so nobody is in range." : muted ? 'Your microphone is muted.' : how;
  } else {
    const [title, text] = STATUS[you.status] || ['Waiting', ''];
    $('#species').textContent = title;
    $('#rule').textContent = text;
    $('#talk-hint').textContent = '';
  }

  // test-mode species picker
  const choose = $('#choose');
  choose.hidden = !state.speciesChoices;
  if (state.speciesChoices) {
    const pick = $('#species-pick');
    if (pick.options.length !== state.speciesChoices.length + 1) {
      pick.textContent = '';
      pick.append(new Option('Choose…', ''));
      for (const s of state.speciesChoices) pick.append(new Option(`${s.name} (${s.category})`, s.id));
    }
    pick.value = you.species?.id || '';
  }

  // group
  $('#group-none').hidden = Boolean(state.group);
  $('#group-in').hidden = !state.group;
  $('#group-create').disabled = !you.species;
  if (state.group) {
    $('#group-code').textContent = state.group.code;
    const list = $('#members');
    list.textContent = '';
    for (const m of state.group.members) list.append(person(m, { withVolume: false }));
  }

  // who you can talk to
  const people = $('#people');
  people.textContent = '';
  for (const p of state.canTalkTo) people.append(person(p, { withVolume: true }));
  const empty = $('#people-empty');
  empty.hidden = state.canTalkTo.length > 0;
  empty.textContent = !you.species ? 'Nobody yet.'
    : state.rule.requireGroup && !state.group ? 'Nobody yet. Start or join a voice group first.'
    : state.proximity ? 'Nobody in range. Players appear here when they are close enough to hear.'
    : 'Nobody yet. Players appear here when the rules let you talk to them.';

  // settings
  $('#mode-ptt').setAttribute('aria-pressed', String(cfg.mode === 'ptt'));
  $('#mode-voice').setAttribute('aria-pressed', String(cfg.mode === 'voice'));
  $('#ptt-row').hidden = cfg.mode !== 'ptt';
  $('#ptt-key').textContent = cfg.pttKey.name;
  $('#call-key').textContent = cfg.callKey.name;
  const off = $('#call-off');
  const serverOff = !state.callMacro.enabled;
  off.hidden = Boolean(desktop) && !serverOff;
  off.textContent = !desktop ? 'The call key needs the desktop app. A web page is not allowed to press keys in your game.' : 'This server has turned the call key off.';
  $('#call-on').disabled = !desktop || serverOff;
  $('#call-key').disabled = !desktop || serverOff;
}

// ---- controls ----------------------------------------------------------------------

function act(promise) {
  promise.catch((e) => notice(e.message, 'error'));
}

async function rebind(button, apply) {
  button.classList.add('listening');
  const before = button.textContent;
  button.textContent = 'Press a key…';
  let binding = null;
  if (desktop) binding = await desktop.captureKey();
  else {
    binding = await new Promise((resolve) => {
      const onKey = (e) => {
        e.preventDefault();
        window.removeEventListener('keydown', onKey, true);
        resolve({ kind: 'web', code: e.code, name: e.key.length === 1 ? e.key.toUpperCase() : e.key });
      };
      window.addEventListener('keydown', onKey, true);
    });
  }
  button.classList.remove('listening');
  button.textContent = before;
  if (binding) apply(binding);
  saveConfig();
  syncKeys();
  render();
}

function syncKeys() {
  if (desktop) desktop.setPttKey(cfg.mode === 'ptt' ? cfg.pttKey : null);
}

function wire() {
  $('#connect-form').addEventListener('submit', signIn);
  const goOffline = () => {
    wantConnected = false;
    clearTimeout(retryTimer);
    attempt = 0;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    else showConnect();
  };
  $('#disconnect').onclick = goOffline;
  $('#wait-stop').onclick = goOffline;
  $('#wait-now').onclick = () => {
    attempt = 0;
    goOnline(true);
  };
  $('#signout').onclick = () => {
    token = null;
    desktop?.clearSession(serverUrl);
    showConnect();
  };
  $('#switch-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let url;
    try {
      url = buildServerUrl($('#set-server').value, $('#set-port').value);
    } catch {
      return notice(BAD_ADDRESS, 'error');
    }
    useServer(url);
  });
  $('#stay').checked = cfg.staySignedIn;
  $('#stay').onchange = (e) => {
    cfg.staySignedIn = e.target.checked;
    saveConfig();
    if (!cfg.staySignedIn) desktop?.clearSession();
  };
  $$('[data-tab]').forEach((b) => (b.onclick = () => {
    $$('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $$('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== b.dataset.tab));
  }));

  $('#mute').onclick = () => {
    muted = !muted;
    $('#mute').setAttribute('aria-pressed', String(muted));
    $('#mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    updateTalking();
    render();
  };
  $('#species-pick').onchange = (e) => act(request('declareSpecies', { speciesId: e.target.value }));
  $('#pos-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act(request('declarePosition', { x: $('#pos-x').value, y: $('#pos-y').value }));
  });
  $('#group-create').onclick = () => act(request('groupCreate'));
  $('#group-leave').onclick = () => act(request('groupLeave'));
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act(request('groupJoin', { code: $('#code').value }).then(() => ($('#code').value = '')));
  });
  $('#copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.group.code);
      $('#copy-code').textContent = 'Copied';
      setTimeout(() => ($('#copy-code').textContent = 'Copy code'), 1500);
    } catch {}
  };

  $('#mic').onchange = (e) => {
    cfg.mic = e.target.value;
    saveConfig();
    act(startMic());
  };
  $('#mode-ptt').onclick = () => { cfg.mode = 'ptt'; saveConfig(); syncKeys(); render(); };
  $('#mode-voice').onclick = () => { cfg.mode = 'voice'; saveConfig(); syncKeys(); render(); };
  $('#ptt-key').onclick = () => rebind($('#ptt-key'), (b) => (cfg.pttKey = b));
  $('#call-key').onclick = () => rebind($('#call-key'), (b) => { if (b.kind === 'key') cfg.callKey = b; });
  $('#threshold').value = cfg.threshold;
  $('#threshold').oninput = (e) => { cfg.threshold = Number(e.target.value); saveConfig(); };
  $('#call-on').checked = cfg.callEnabled;
  $('#call-on').onchange = (e) => { cfg.callEnabled = e.target.checked; saveConfig(); };
  $('#cooldown').value = cfg.cooldown;
  $('#cooldown').oninput = (e) => { cfg.cooldown = Math.max(0, Number(e.target.value) || 0); saveConfig(); };

  // push to talk
  if (desktop) {
    desktop.onPtt((down) => { pttHeld = down; updateTalking(); });
  } else {
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    window.addEventListener('keydown', (e) => { if (e.code === cfg.pttKey.code && !typing(e)) { pttHeld = true; updateTalking(); } });
    window.addEventListener('keyup', (e) => { if (e.code === cfg.pttKey.code) { pttHeld = false; updateTalking(); } });
    window.addEventListener('blur', () => { pttHeld = false; updateTalking(); });
  }
}

(async function main() {
  $('#version').textContent = __APP_VERSION__;
  await loadConfig();
  wire();
  syncKeys();
  window.IsleTheme.mount($('#wheel'));
  if (desktop) {
    fillServerFields();
    // Start-up: if you signed in before, look for the voice service straight
    // away, quietly. With no saved sign-in the app just waits on this screen.
    if (cfg.server && cfg.staySignedIn) {
      const saved = await desktop.loadSession(cfg.server);
      if (saved) {
        serverUrl = cfg.server;
        token = saved;
        fillServerFields();
        goOnline();
      }
    }
  } else {
    $('#server-field').hidden = true;
    $('#server').required = false;
    $('#stay-field').hidden = true;
    $('#server-settings').hidden = true; // a web page always talks to the server it came from
    // coming back from Steam sign-in in a browser
    let saved = null;
    try {
      saved = sessionStorage.getItem('isleVoipToken');
      sessionStorage.removeItem('isleVoipToken');
    } catch {}
    if (saved) {
      token = saved;
      serverUrl = location.origin;
      goOnline();
    }
  }
})();
