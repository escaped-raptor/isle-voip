// Where the server learns which species each player is.
//   rcon   - asks an Evrima server over RCON (recommended)
//   legacy - reads Legacy player save files (<SteamID64>.json)
//   manual - players pick their own species in the client (testing only)
import fs from 'node:fs/promises';
import path from 'node:path';
import { OP, parsePlayerData, rconCommand } from './rcon.js';

export class SpeciesSource {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.health = { ok: null, message: 'Not checked yet.', at: null };
  }

  get type() {
    return this.getSettings().speciesSource.type;
  }

  /** How far player positions can be trusted for proximity (see policy.inRange). */
  get positionMode() {
    return { rcon: 'required', manual: 'optional', legacy: 'off' }[this.type];
  }

  /**
   * Look up players. Returns Map<steamId, { className, name, pos }>.
   * A SteamID missing from the map means "not spawned in the game right now".
   * Returns null when the lookup itself failed (keep previous answers).
   */
  async lookup(steamIds) {
    const cfg = this.getSettings().speciesSource;
    try {
      let result;
      if (cfg.type === 'rcon') result = await this.#rcon(cfg.rcon);
      else if (cfg.type === 'legacy') result = await this.#legacy(cfg.legacy, steamIds);
      else return new Map();
      this.health = { ok: true, message: `Found ${result.size} spawned player(s).`, at: Date.now() };
      return result;
    } catch (err) {
      this.health = { ok: false, message: err.message, at: Date.now() };
      return null;
    }
  }

  async #rcon(rcon) {
    if (!rcon.password) throw new Error('No RCON password set.');
    const text = await rconCommand(rcon, OP.playerData);
    const map = new Map();
    for (const p of parsePlayerData(text)) map.set(p.steamId, { className: p.className, name: p.name, pos: p.pos });
    return map;
  }

  async #legacy(legacy, steamIds) {
    if (!legacy.dir) throw new Error('No Legacy save folder set.');
    await fs.access(legacy.dir);
    const map = new Map();
    for (const id of steamIds) {
      if (!/^\d{17}$/.test(id)) continue;
      try {
        const save = JSON.parse(await fs.readFile(path.join(legacy.dir, `${id}.json`), 'utf8'));
        if (save.CharacterClass) map.set(id, { className: String(save.CharacterClass), name: '' });
      } catch {
        // No save file: the player has no living dinosaur.
      }
    }
    return map;
  }

  /** Used by the admin panel's "Test connection" button. */
  async test() {
    const cfg = this.getSettings().speciesSource;
    if (cfg.type === 'rcon') {
      const raw = await rconCommand(cfg.rcon, OP.playerData);
      return { raw: raw.slice(0, 4000), players: parsePlayerData(raw) };
    }
    if (cfg.type === 'legacy') {
      const files = (await fs.readdir(cfg.legacy.dir)).filter((f) => /^\d{17}\.json$/.test(f));
      return { raw: `${files.length} save file(s) found.`, players: [] };
    }
    return { raw: 'Manual mode: players choose their own species. Nothing to test.', players: [] };
  }
}
