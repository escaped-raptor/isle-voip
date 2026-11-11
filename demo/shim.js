// Demo only. Replaces the server, the game and the desktop shell with made-up
// data so the real GUI pages can be clicked through in a browser.
// __DEMO__ = { page, settings, versionLabel } is filled in by build-demo.mjs.
(function () {
  'use strict';
  var D = window.__DEMO__;
  var day = 24 * 3600 * 1000;
  var NAME = 'Demo Isle Server';

  // ---- small helpers -----------------------------------------------------
  function reply(obj, status) {
    return Promise.resolve(new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } }));
  }
  function toast(text) {
    var box = document.getElementById('demo-toast');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { box.hidden = true; }, 4200);
  }
  try {
    var replaceState = history.replaceState.bind(history);
    history.replaceState = function () { try { replaceState.apply(null, arguments); } catch (e) { /* not allowed here; harmless */ } };
  } catch (e) { /* ignore */ }

  // ---- the demo bar ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.id = 'demo-bar';
    bar.innerHTML = '<strong>Demo</strong><span>Made-up data. Nothing is saved.</span>';
    if (D.page === 'client') {
      var talk = document.createElement('button');
      talk.type = 'button';
      talk.textContent = 'Hold to simulate your voice';
      var loud = function (on) { return function (e) { e.preventDefault(); if (window.__demoVoice) window.__demoVoice(on); }; };
      talk.addEventListener('pointerdown', loud(true));
      talk.addEventListener('pointerup', loud(false));
      talk.addEventListener('pointerleave', loud(false));
      bar.appendChild(talk);
    }
    var back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back to demo menu';
    back.addEventListener('click', function () { if (window.__demoOpen) window.__demoOpen('menu'); else location.reload(); });
    bar.appendChild(back);
    var t = document.createElement('div');
    t.id = 'demo-toast';
    t.hidden = true;
    t.setAttribute('role', 'status');
    document.body.appendChild(bar);
    document.body.appendChild(t);
    if (D.page === 'admin') {
      var hint = document.createElement('p');
      hint.className = 'muted small';
      hint.textContent = 'Demo: type any password.';
      var form = document.getElementById('login-form');
      if (form) form.insertBefore(hint, form.querySelector('button'));
    }
    if (D.page === 'setup') {
      var done = document.getElementById('done-local');
      if (done) done.addEventListener('click', function (e) { e.preventDefault(); window.__demoOpen && window.__demoOpen('admin'); });
    }
  });

  // ---- pretend server (HTTP) ---------------------------------------------------
  var settings = JSON.parse(JSON.stringify(D.settings));
  var info = {
    service: 'species-voip', protocol: 1, publicUrl: 'https://voice.example.com:7777',
    app: 'Species Specific VoIP (The Isle Evrima)', name: NAME, versionLabel: D.versionLabel,
    version: D.versionLabel.replace(/^v| .*$/g, ''), authMode: 'steam', source: 'rcon', webClient: true
  };
  var players = [
    ['Rexy', 'Carnotaurus', 'carnivore', 'K7M2QX', 2, [1204, -388, 12]],
    ['Carno Kev', 'Carnotaurus', 'carnivore', 'K7M2QX', 2, [1262, -351, 14]],
    ['Jem', 'Carnotaurus', 'carnivore', 'K7M2QX', 2, [1231, -402, 12]],
    ['Stegz', 'Stegosaurus', 'herbivore', 'P4T9WD', 1, [-2210, 940, 31]],
    ['MaiaMum', 'Maiasaura', 'herbivore', 'P4T9WD', 1, [-2190, 987, 30]],
    ['Galli Gal', 'Gallimimus', 'omnivore', '', 0, [310, 2755, 8]],
    ['NewHatchling', '', '', '', 0, null]
  ];
  function status() {
    return {
      players: players.map(function (p, i) {
        return { name: p[0], steamId: '7656119800000' + (1041 + i * 137), species: p[1], category: p[2], className: p[1] ? 'BP_' + p[1] + '_C' : '',
          status: p[1] ? 'ok' : 'not-spawned', group: p[3], hears: p[4], pos: p[5] ? { x: p[5][0], y: p[5][1], z: p[5][2] } : null };
      }),
      groups: 2,
      unknownClasses: ['BP_Triceratops_C'],
      source: { type: 'rcon', ok: true, message: 'Found 6 spawned player(s).', at: Date.now() },
      proximity: { active: true, mode: 'required' },
      https: { mode: 'automatic', issuer: "Let's Encrypt", validFrom: new Date(Date.now() - 28 * day).toISOString(), validTo: new Date(Date.now() + 62 * day).toISOString(), daysLeft: 62 },
      testing: null
    };
  }
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = String(typeof input === 'string' ? input : input.url);
    var path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { /* not JSON */ }
    if (/\/api\/info$/.test(path)) return reply(info);
    if (/\/api\/admin\/login$/.test(path)) return reply({ token: 'demo' });
    if (/\/api\/admin\/settings$/.test(path)) {
      if (method === 'PUT') {
        settings = body;
        settings.species.forEach(function (s) { if (!s.id) s.id = String(s.name || 'species').toLowerCase().replace(/[^a-z0-9]+/g, '-'); });
        toast('Saved (in this demo only).');
      }
      return reply(settings);
    }
    if (/\/api\/admin\/status$/.test(path)) return reply(status());
    if (/\/api\/admin\/test-source$/.test(path)) {
      return reply({
        raw: 'PlayerDataName: Rexy, PlayerID: 76561198000001041, Location: X=120400.0 Y=-38800.0 Z=1200.0, Class: BP_Carnotaurus_C, Growth: 0.75\nName: Stegz, PlayerID: 76561198000001452, Location: X=-221000.0 Y=94000.0 Z=3100.0, Class: BP_Stegosaurus_C, Growth: 1.00',
        players: [{ name: 'Rexy', steamId: '76561198000001041', className: 'BP_Carnotaurus_C' }, { name: 'Stegz', steamId: '76561198000001452', className: 'BP_Stegosaurus_C' }]
      });
    }
    if (/\/api\/admin\/password$/.test(path)) return reply({});
    if (/\/api\/setup\/detect-ip$/.test(path)) return reply({ ip: '203.0.113.10' });
    if (/\/api\/setup$/.test(path)) {
      if (String(body.password || '').length < 10) return reply({ error: 'Choose an admin password of at least 10 characters.' }, 400);
      if (body.mode !== 'test' && !/\./.test(String(body.address || ''))) return reply({ error: 'Enter the voice address players will use, like voice.example.com.' }, 400);
      if (body.mode === 'auto' && body.agree !== true) return reply({ error: "Tick the box to agree to the Let's Encrypt Subscriber Agreement. The free certificate is issued under it." }, 400);
      if (body.mode === 'certificate' && !(body.cert && body.key)) return reply({ error: 'No certificate chosen. Choose the certificate and key files, or pick "I don\'t have one" to get a free certificate automatically.' }, 400);
      var host = body.mode === 'test' ? 'localhost' : String(body.address).replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
      var port = Number(body.port) || 7777;
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(reply({
            localUrl: '#', publicUrl: (body.mode === 'test' ? 'http://' : 'https://') + host + ':' + port + '/admin/', port: port, audioPort: Number(body.audioPort) || 40000,
            https: body.mode === 'auto' ? { issuer: "Let's Encrypt", validTo: new Date(Date.now() + 90 * day).toISOString() } : null, testing: body.mode === 'test'
          }));
        }, body.mode === 'auto' ? 1800 : 300);
      });
    }
    return realFetch ? realFetch(input, init) : Promise.reject(new Error('offline demo'));
  };

  if (D.page !== 'client') return;

  // ---- pretend microphone ----------------------------------------------------------
  var voiceGain = null;
  window.__demoVoice = function (on) { if (voiceGain) voiceGain.gain.value = on ? 0.35 : 0.002; };
  var media = navigator.mediaDevices || {};
  try { Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true }); } catch (e) { /* already there */ }
  media.getUserMedia = function () {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var osc = ctx.createOscillator();
    osc.frequency.value = 180;
    voiceGain = ctx.createGain();
    voiceGain.gain.value = 0.002;
    var out = ctx.createMediaStreamDestination(); // goes to the level meter only, never to the speakers
    osc.connect(voiceGain).connect(out);
    osc.start();
    ctx.resume().catch(function () {});
    return Promise.resolve(out.stream);
  };
  media.enumerateDevices = function () { return Promise.resolve([{ kind: 'audioinput', deviceId: 'demo', label: 'Demo microphone' }]); };

  // ---- pretend desktop shell ---------------------------------------------------------
  var cfg = { server: 'https://voice.example.com:7777' }; // as if this player had used the server before
  var ptt = null;
  var pttCb = null;
  var typing = function (e) { return /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName); };
  var keyName = function (e) { return e.key.length === 1 ? e.key.toUpperCase() : e.key; };
  window.addEventListener('keydown', function (e) { if (ptt && !e.repeat && !typing(e) && keyName(e) === ptt.name && pttCb) pttCb(true); });
  window.addEventListener('keyup', function (e) { if (ptt && keyName(e) === ptt.name && pttCb) pttCb(false); });
  window.isleDesktop = {
    getConfig: function () { return Promise.resolve(cfg); },
    setConfig: function (patch) { Object.assign(cfg, patch); return Promise.resolve(); },
    steamLogin: function () {
      toast("Demo: in the real app, Steam's own sign-in page opens here.");
      return new Promise(function (r) { setTimeout(function () { r('demo-token'); }, 900); });
    },
    loadSession: function () { return Promise.resolve(null); },
    saveSession: function () { return Promise.resolve(true); },
    clearSession: function () { return Promise.resolve(); },
    setPttKey: function (binding) { ptt = binding; return Promise.resolve(); },
    captureKey: function () {
      return new Promise(function (resolve) {
        var onKey = function (e) { e.preventDefault(); window.removeEventListener('keydown', onKey, true); resolve({ kind: 'key', code: e.keyCode, name: keyName(e) }); };
        window.addEventListener('keydown', onKey, true);
        setTimeout(function () { window.removeEventListener('keydown', onKey, true); resolve(null); }, 8000);
      });
    },
    tapKey: function () { toast('Call key pressed. In the real app this presses the key in your game, so your dinosaur calls.'); return Promise.resolve(); },
    onPtt: function (cb) { pttCb = cb; }
  };

  // ---- pretend voice server (WebSocket) ------------------------------------------------
  var others = [
    { peerId: 'p1', name: 'Rexy', species: 'Carnotaurus', gain: 1 },
    { peerId: 'p2', name: 'Carno Kev', species: 'Carnotaurus', gain: 0.6 }
  ];
  function MockSocket() {
    var self = this;
    this.readyState = 0;
    this.group = null;
    this.timers = [];
    setTimeout(function () { self.readyState = 1; if (self.onopen) self.onopen(); }, 200);
  }
  MockSocket.CONNECTING = 0; MockSocket.OPEN = 1; MockSocket.CLOSING = 2; MockSocket.CLOSED = 3;
  MockSocket.prototype.push = function (msg) {
    var self = this;
    setTimeout(function () { if (self.readyState === 1 && self.onmessage) self.onmessage({ data: JSON.stringify(msg) }); }, 60);
  };
  MockSocket.prototype.state = function () {
    var me = { peerId: 'me', name: 'Jem', species: 'Carnotaurus', you: true };
    var full = this.group && this.group.full;
    this.push({
      type: 'state',
      you: { peerId: 'me', name: 'Jem', status: 'ok', className: 'BP_Carnotaurus_C', species: { id: 'carnotaurus', name: 'Carnotaurus', category: 'carnivore' } },
      rule: { scope: 'species', requireGroup: true, also: [] },
      group: this.group ? { code: this.group.code, members: [me].concat(full ? others : []) } : null,
      canTalkTo: full ? others : [],
      proximity: { rangeMetres: 100, located: true },
      callMacro: { enabled: true },
      source: 'rcon'
    });
  };
  MockSocket.prototype.fill = function () {
    var self = this;
    this.timers.push(setTimeout(function () {
      if (!self.group) return;
      self.group.full = true;
      self.state();
      others.forEach(function (p, i) { self.push({ type: 'newConsumer', peerId: p.peerId, consumerId: 'c' + i, producerId: 'pr' + i, kind: 'audio', rtpParameters: {} }); });
      var turn = 0;
      self.timers.push(setInterval(function () {
        var p = others[turn % 2];
        self.push({ type: 'speaking', peerId: p.peerId, on: true });
        setTimeout(function () { self.push({ type: 'speaking', peerId: p.peerId, on: false }); }, 1700);
        turn++;
      }, 3400));
    }, 2200));
  };
  MockSocket.prototype.empty = function () {
    var self = this;
    this.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    this.timers = [];
    if (this.group && this.group.full) others.forEach(function (p, i) { self.push({ type: 'consumerClosed', consumerId: 'c' + i, peerId: p.peerId }); });
    this.group = null;
  };
  MockSocket.prototype.send = function (raw) {
    var m = JSON.parse(raw);
    var ok = function (self, data) { if (m.id != null) self.push({ replyTo: m.id, ok: true, data: data || {} }); };
    if (m.type === 'hello') { ok(this, { routerRtpCapabilities: {}, serverName: NAME }); this.state(); return; }
    if (m.type === 'createTransport') return ok(this, { id: 't-' + m.direction, iceParameters: {}, iceCandidates: [], dtlsParameters: {} });
    if (m.type === 'produce') return ok(this, { id: 'producer' });
    if (m.type === 'groupCreate') { this.empty(); this.group = { code: 'K7M2QX' }; ok(this); this.state(); this.fill(); toast('Demo: two group members will join in a moment.'); return; }
    if (m.type === 'groupJoin') {
      var code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) { if (m.id != null) this.push({ replyTo: m.id, ok: false, error: 'No group has that code.' }); return; }
      this.empty(); this.group = { code: code.slice(0, 6) }; ok(this); this.state(); this.fill(); return;
    }
    if (m.type === 'groupLeave') { this.empty(); ok(this); this.state(); return; }
    ok(this);
  };
  MockSocket.prototype.close = function () {
    var self = this;
    this.empty();
    this.readyState = 3;
    setTimeout(function () { if (self.onclose) self.onclose({}); }, 0);
  };
  window.WebSocket = MockSocket;
})();
