// The hub tracks connected players, their verified species and their voice
// groups, and keeps the audio routing in line with the rules at all times.
import crypto from 'node:crypto';
import { canTalk as rulesAllow, compatibleSpecies, effectiveRule, fadeGain, getSpecies, matchSpecies } from './policy.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
// A stand-in name for a player the game has not named yet. It is stable for
// one player while the server runs, and gives away no part of their SteamID.
const nameSalt = crypto.randomBytes(16);
const standInName = (steamId) => `Player ${crypto.createHmac('sha256', nameSalt).update(steamId).digest('hex').slice(0, 4).toUpperCase()}`;
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

export class Hub {
  constructor({ store, sfu, source, log = () => {} }) {
    this.store = store;
    this.sfu = sfu;
    this.source = source;
    this.log = log;
    this.peers = new Map(); // peerId -> peer
    this.groups = new Map(); // code -> Set<peerId>
    this.unknownClasses = new Map(); // class name the game reported that matches no species -> last seen
    this.queue = Promise.resolve();
    this.timer = null;
    this.stopped = false;
    this.#schedule();
  }

  /** Rules + proximity. `open` = a stream already exists (keeps it to 110% of range). */
  #canTalk(a, b, open = false) {
    return rulesAllow(this.store.get(), a, b, { proximity: this.source.positionMode, rangeScale: open ? 1.1 : 1 });
  }

  #proximityOn() {
    return this.store.get().proximity.enabled && this.source.positionMode !== 'off';
  }

  // ---- lifecycle -----------------------------------------------------------

  #schedule() {
    if (this.stopped) return;
    // Positions and species arrive in the same reply, so with proximity on we
    // simply ask more often.
    const st = this.store.get();
    const seconds = this.#proximityOn() && this.source.type === 'rcon' ? Math.min(st.proximity.updateSeconds, st.speciesSource.recheckSeconds) : st.speciesSource.recheckSeconds;
    this.timer = setTimeout(async () => {
      await this.refreshSpecies().catch((err) => this.log('species check failed', err.message));
      this.#schedule();
    }, seconds * 1000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const p of [...this.peers.values()]) this.removePeer(p, 'The voice server is shutting down.');
  }

  /** A player connected. Their species is checked before they can talk to anyone. */
  async addPeer({ steamId, send, close }) {
    for (const old of [...this.peers.values()]) {
      if (old.steamId === steamId) this.removePeer(old, 'You connected from somewhere else.');
    }
    const peer = {
      id: crypto.randomBytes(8).toString('hex'),
      steamId,
      name: standInName(steamId),
      send,
      close,
      closed: false,
      className: '',
      declaredClass: '',
      speciesId: null,
      pos: null, // { x, y, z } in game units
      lastState: '',
      groupId: null,
      caps: null,
      sendTransport: null,
      recvTransport: null,
      producer: null,
      consumers: new Map(), // speaker peerId -> consumer
      joinTries: [],
      lastRefresh: 0
    };
    this.peers.set(peer.id, peer);
    await this.refreshSpecies(peer);
    return peer;
  }

  removePeer(peer, reason) {
    if (peer.closed) return;
    peer.closed = true;
    this.peers.delete(peer.id);
    this.#leaveGroup(peer);
    for (const c of peer.consumers.values()) c.close();
    peer.consumers.clear();
    peer.sendTransport?.close();
    peer.recvTransport?.close();
    if (reason) peer.send({ type: 'notice', level: 'error', text: reason });
    peer.close?.();
    this.sync();
    this.pushAll();
  }

  // ---- species verification -----------------------------------------------

  #setClass(peer, className, name) {
    peer.className = className || '';
    if (name) peer.name = String(name).slice(0, 40);
    const species = matchSpecies(this.store.get(), peer.className);
    peer.speciesId = species ? species.id : null;
    if (peer.className && !species) this.unknownClasses.set(peer.className, Date.now());
  }

  /** Re-check species for one player (on join) or everyone (on a timer). */
  async refreshSpecies(only) {
    const peers = only ? [only] : [...this.peers.values()];
    if (!peers.length) return;
    if (this.source.type === 'manual') {
      for (const p of peers) this.#setClass(p, p.declaredClass);
    } else {
      const found = await this.source.lookup(peers.map((p) => p.steamId));
      // If the lookup itself failed, keep what we knew. New players stay
      // species-less (and so silent) until a lookup succeeds.
      if (found) {
        for (const p of peers) {
          const entry = found.get(p.steamId);
          this.#setClass(p, entry?.className || '', entry?.name);
          p.pos = entry?.pos || null;
        }
      }
    }
    this.#enforceGroups();
    this.sync();
    this.pushAll();
  }

  /** Called after the admin saves new settings. */
  onSettingsChanged() {
    for (const p of this.peers.values()) this.#setClass(p, p.className);
    this.#enforceGroups();
    this.sync();
    this.pushAll();
    clearTimeout(this.timer);
    this.#schedule();
  }

  // ---- groups --------------------------------------------------------------

  #leaveGroup(peer) {
    if (!peer.groupId) return;
    const members = this.groups.get(peer.groupId);
    members?.delete(peer.id);
    if (members && members.size === 0) this.groups.delete(peer.groupId);
    peer.groupId = null;
  }

  /** Drop anyone whose species no longer fits their group (death, respawn, rule change). */
  #enforceGroups() {
    const settings = this.store.get();
    for (const [, members] of [...this.groups]) {
      const list = [...members].map((id) => this.peers.get(id)).filter(Boolean);
      const anchor = list.find((p) => p.speciesId);
      for (const p of list) {
        const fits = p.speciesId && anchor && (p === anchor || compatibleSpecies(settings, anchor.speciesId, p.speciesId));
        if (!fits) {
          this.#leaveGroup(p);
          p.send({
            type: 'notice',
            level: 'warn',
            text: p.speciesId ? 'Your species changed, so you left your voice group.' : 'You are no longer spawned, so you left your voice group.'
          });
        }
      }
    }
  }

  #createGroup(peer) {
    if (!peer.speciesId) throw new Error('Spawn in the game before starting a group.');
    this.#leaveGroup(peer);
    let code = newCode();
    while (this.groups.has(code)) code = newCode();
    this.groups.set(code, new Set([peer.id]));
    peer.groupId = code;
  }

  #joinGroup(peer, rawCode) {
    const now = Date.now();
    peer.joinTries = peer.joinTries.filter((t) => now - t < 60_000);
    if (peer.joinTries.length >= 10) throw new Error('Too many attempts. Wait a minute and try again.');
    peer.joinTries.push(now);

    if (!peer.speciesId) throw new Error('Spawn in the game before joining a group.');
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const members = this.groups.get(code);
    if (!members) throw new Error('No group has that code.');
    if (members.has(peer.id)) return;
    const settings = this.store.get();
    const max = settings.groups.maxSize;
    if (max > 0 && members.size >= max) throw new Error('That group is full.');
    for (const id of members) {
      const m = this.peers.get(id);
      if (m && !compatibleSpecies(settings, peer.speciesId, m.speciesId)) {
        throw new Error("Your species can't join that group on this server.");
      }
    }
    this.#leaveGroup(peer);
    members.add(peer.id);
    peer.groupId = code;
  }

  // ---- audio routing -------------------------------------------------------

  /** Bring every listener's audio streams in line with the rules. Calls are queued so they never overlap. */
  sync() {
    this.queue = this.queue.then(() => this.#sync()).catch((err) => this.log('routing error', err.message));
    return this.queue;
  }

  async #sync() {
    for (const listener of [...this.peers.values()]) {
      // 1. Cut streams that are no longer allowed.
      for (const [speakerId, consumer] of [...listener.consumers]) {
        const speaker = this.peers.get(speakerId);
        const ok = speaker && speaker.producer && !speaker.producer.closed && this.#canTalk(listener, speaker, true);
        if (!ok) {
          consumer.close();
          listener.consumers.delete(speakerId);
          listener.send({ type: 'consumerClosed', consumerId: consumer.id, peerId: speakerId });
        }
      }
      // 2. Open streams that are newly allowed.
      if (!listener.recvTransport || !listener.caps) continue;
      for (const speaker of [...this.peers.values()]) {
        if (speaker === listener || !speaker.producer || speaker.producer.closed) continue;
        if (listener.consumers.has(speaker.id)) continue;
        if (!this.#canTalk(listener, speaker)) continue;
        if (!this.sfu.router.canConsume({ producerId: speaker.producer.id, rtpCapabilities: listener.caps })) continue;
        let consumer;
        try {
          consumer = await listener.recvTransport.consume({
            producerId: speaker.producer.id,
            rtpCapabilities: listener.caps,
            paused: true
          });
        } catch {
          continue; // transport or producer closed while we were waiting
        }
        // Things may have changed while we waited: check again before telling the client.
        if (listener.closed || speaker.closed || !this.#canTalk(listener, speaker)) {
          consumer.close();
          continue;
        }
        listener.consumers.set(speaker.id, consumer);
        listener.send({
          type: 'newConsumer',
          peerId: speaker.id,
          consumerId: consumer.id,
          producerId: speaker.producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });
      }
    }
  }

  // ---- state shown to players ----------------------------------------------

  #status(peer) {
    if (peer.speciesId) return 'ok';
    if (peer.className) return 'unknown-species';
    if (this.source.type !== 'manual' && this.source.health.ok === false) return 'source-down';
    return this.source.type === 'manual' ? 'choose-species' : 'not-spawned';
  }

  stateFor(peer) {
    const settings = this.store.get();
    const species = getSpecies(settings, peer.speciesId);
    const brief = (p) => ({ peerId: p.id, name: p.name, species: getSpecies(settings, p.speciesId)?.name || '' });
    const members = peer.groupId ? [...(this.groups.get(peer.groupId) || [])].map((id) => this.peers.get(id)).filter(Boolean) : [];
    return {
      type: 'state',
      you: {
        peerId: peer.id,
        name: peer.name,
        status: this.#status(peer),
        className: peer.className,
        species: species && { id: species.id, name: species.name, category: species.category }
      },
      rule: species ? effectiveRule(settings, species) : null,
      group: peer.groupId ? { code: peer.groupId, members: members.map((m) => ({ ...brief(m), you: m === peer })) } : null,
      // People this player is connected to right now, with a volume for distance.
      canTalkTo: [...this.peers.values()]
        .filter((p) => p !== peer && this.#canTalk(peer, p, peer.consumers.has(p.id)))
        .map((p) => ({ ...brief(p), gain: fadeGain(settings, peer, p, this.source.positionMode) })),
      proximity: this.#proximityOn() ? { rangeMetres: settings.proximity.rangeMetres, located: Boolean(peer.pos) || this.source.positionMode !== 'required' } : null,
      callMacro: settings.callMacro,
      source: this.source.type,
      speciesChoices: this.source.type === 'manual' ? settings.species.map((s) => ({ id: s.id, name: s.name, category: s.category })) : undefined
    };
  }

  /** Send each player their state, but only when it actually changed. */
  pushAll() {
    for (const p of this.peers.values()) {
      const state = this.stateFor(p);
      const json = JSON.stringify(state);
      if (json === p.lastState) continue;
      p.lastState = json;
      p.send(state);
    }
  }

  // ---- requests from a player's client -------------------------------------

  async handle(peer, msg) {
    switch (msg.type) {
      case 'setCaps':
        peer.caps = msg.rtpCapabilities;
        this.sync();
        return {};

      case 'createTransport': {
        const dir = msg.direction === 'send' ? 'sendTransport' : 'recvTransport';
        peer[dir]?.close();
        const t = await this.sfu.createTransport();
        if (peer.closed) {
          t.close();
          throw new Error('Disconnected.');
        }
        peer[dir] = t;
        if (dir === 'recvTransport') this.sync();
        // iceCandidates only ever contain THIS SERVER's address.
        return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
      }

      case 'connectTransport': {
        const t = msg.direction === 'send' ? peer.sendTransport : peer.recvTransport;
        if (!t) throw new Error('No transport.');
        await t.connect({ dtlsParameters: msg.dtlsParameters });
        return {};
      }

      case 'produce': {
        if (!peer.sendTransport) throw new Error('No transport.');
        if (msg.kind !== 'audio') throw new Error('Only audio is allowed.');
        peer.producer?.close();
        peer.producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters: msg.rtpParameters });
        this.sync();
        return { id: peer.producer.id };
      }

      case 'resumeConsumer': {
        const consumer = [...peer.consumers.values()].find((c) => c.id === msg.consumerId);
        if (consumer) await consumer.resume();
        return {};
      }

      case 'speaking': {
        // Only people who can actually hear this player are told they are talking.
        for (const p of this.peers.values()) {
          if (p.consumers.has(peer.id)) p.send({ type: 'speaking', peerId: peer.id, on: Boolean(msg.on) });
        }
        return {};
      }

      case 'groupCreate':
        this.#createGroup(peer);
        break;
      case 'groupJoin':
        this.#joinGroup(peer, msg.code);
        break;
      case 'groupLeave':
        this.#leaveGroup(peer);
        break;

      case 'declareSpecies': {
        if (this.source.type !== 'manual') throw new Error('This server checks your species automatically.');
        const species = getSpecies(this.store.get(), String(msg.speciesId || ''));
        peer.declaredClass = species ? species.name : '';
        await this.refreshSpecies(peer);
        return {};
      }

      case 'declarePosition': {
        // Test mode only: lets you try proximity without a game server.
        if (this.source.type !== 'manual') throw new Error('This server reads your position from the game.');
        const m = this.store.get().proximity.unitsPerMetre;
        const given = (v) => v !== '' && v != null && Number.isFinite(Number(v));
        peer.pos = given(msg.x) && given(msg.y) ? { x: Number(msg.x) * m, y: Number(msg.y) * m, z: 0 } : null;
        break;
      }

      case 'refresh': {
        if (Date.now() - peer.lastRefresh < 5000) return {};
        peer.lastRefresh = Date.now();
        await this.refreshSpecies(peer);
        return {};
      }

      default:
        throw new Error('Unknown request.');
    }
    this.sync();
    this.pushAll();
    return {};
  }

  // ---- for the admin panel -------------------------------------------------

  adminStatus() {
    const settings = this.store.get();
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [name, at] of this.unknownClasses) {
      if (at < cutoff || matchSpecies(settings, name)) this.unknownClasses.delete(name);
    }
    return {
      players: [...this.peers.values()].map((p) => ({
        name: p.name,
        steamId: p.steamId,
        species: getSpecies(settings, p.speciesId)?.name || '',
        category: getSpecies(settings, p.speciesId)?.category || '',
        className: p.className,
        status: this.#status(p),
        group: p.groupId || '',
        hears: p.consumers.size,
        // position in metres, for measuring distances when setting the hearing range
        pos: p.pos ? { x: Math.round(p.pos.x / settings.proximity.unitsPerMetre), y: Math.round(p.pos.y / settings.proximity.unitsPerMetre), z: Math.round(p.pos.z / settings.proximity.unitsPerMetre) } : null
      })),
      groups: this.groups.size,
      unknownClasses: [...this.unknownClasses.keys()],
      proximity: { active: this.#proximityOn(), mode: this.source.positionMode },
      source: { type: this.source.type, ...this.source.health }
    };
  }
}
