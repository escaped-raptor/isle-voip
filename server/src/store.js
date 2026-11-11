// Settings storage and validation. Settings live in data/settings.json and
// are edited through the admin panel.
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES, SCOPES, defaultSettings } from './defaults.js';

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

const str = (v, max = 200) => String(v ?? '').slice(0, max);

function cleanRule(rule, { allowNull, speciesIds }) {
  if (rule == null) {
    if (allowNull) return null;
    throw new Error('A category rule is missing.');
  }
  const out = {};
  if (rule.scope != null) {
    if (!SCOPES.includes(rule.scope)) throw new Error(`Unknown scope "${rule.scope}".`);
    out.scope = rule.scope;
  }
  if (rule.requireGroup != null) out.requireGroup = Boolean(rule.requireGroup);
  if (speciesIds && Array.isArray(rule.also)) {
    out.also = [...new Set(rule.also.map(String))].filter((id) => speciesIds.has(id));
  }
  if (!allowNull && (out.scope == null || out.requireGroup == null)) {
    throw new Error('A category rule needs both a scope and a group setting.');
  }
  return out;
}

/** Validate untrusted input and return a clean settings object. Throws on bad data. */
export function sanitizeSettings(input, previous = defaultSettings()) {
  if (!input || typeof input !== 'object') throw new Error('Settings must be an object.');
  const base = defaultSettings();
  const out = {};

  out.categories = {};
  for (const c of CATEGORIES) {
    out.categories[c] = cleanRule(input.categories?.[c] ?? base.categories[c], { allowNull: false });
  }

  if (!Array.isArray(input.species)) throw new Error('Species must be a list.');
  if (input.species.length > 500) throw new Error('Too many species.');
  const seen = new Set();
  const species = input.species.map((s) => {
    const name = str(s.name, 60).trim();
    if (!name) throw new Error('Every species needs a name.');
    const id = slug(s.id || name);
    if (!id) throw new Error(`"${name}" needs a name with letters or numbers.`);
    if (seen.has(id)) throw new Error(`Two species share the name "${name}".`);
    seen.add(id);
    if (!CATEGORIES.includes(s.category)) throw new Error(`"${name}" needs a category.`);
    const classNames = [...new Set((Array.isArray(s.classNames) ? s.classNames : [name]).map((c) => str(c, 80).trim()).filter(Boolean))].slice(0, 20);
    return { id, name, category: s.category, classNames: classNames.length ? classNames : [name], rule: s.rule ?? null };
  });
  for (const s of species) s.rule = cleanRule(s.rule, { allowNull: true, speciesIds: seen });
  out.species = species;

  out.callMacro = { enabled: Boolean(input.callMacro?.enabled ?? base.callMacro.enabled) };

  const maxSize = Number(input.groups?.maxSize ?? 0);
  out.groups = { maxSize: Number.isFinite(maxSize) ? Math.max(0, Math.min(500, Math.floor(maxSize))) : 0 };

  const px = input.proximity || {};
  const num = (v, def, min, max) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.max(min, Math.min(max, Number(v))) : def);
  out.proximity = {
    enabled: Boolean(px.enabled ?? base.proximity.enabled),
    rangeMetres: Math.round(num(px.rangeMetres, base.proximity.rangeMetres, 1, 100000)),
    fade: Boolean(px.fade ?? base.proximity.fade),
    updateSeconds: Math.round(num(px.updateSeconds, base.proximity.updateSeconds, 1, 60)),
    unitsPerMetre: num(px.unitsPerMetre, base.proximity.unitsPerMetre, 0.001, 100000)
  };

  // Testing mode only: the SteamIDs allowed to connect (at most 30).
  const list = Array.isArray(input.testAccess?.whitelist) ? input.testAccess.whitelist : [];
  out.testAccess = { whitelist: [...new Set(list.map((v) => String(v).trim()).filter((v) => /^\d{17}$/.test(v)))].slice(0, 30) };

  const src = input.speciesSource || {};
  const type = ['rcon', 'legacy', 'manual'].includes(src.type) ? src.type : base.speciesSource.type;
  const recheck = Number(src.recheckSeconds ?? base.speciesSource.recheckSeconds);
  const port = Number(src.rcon?.port ?? base.speciesSource.rcon.port);
  out.speciesSource = {
    type,
    recheckSeconds: Number.isFinite(recheck) ? Math.max(5, Math.min(600, Math.floor(recheck))) : 20,
    rcon: {
      host: str(src.rcon?.host ?? base.speciesSource.rcon.host, 255).trim(),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8888,
      // An empty or missing password means "keep the one already saved".
      password: src.rcon?.password ? str(src.rcon.password, 200) : previous.speciesSource?.rcon?.password || ''
    },
    legacy: { dir: str(src.legacy?.dir ?? '', 500).trim() }
  };
  return out;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.settings = defaultSettings();
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.settings = sanitizeSettings(raw, raw);
      } catch (err) {
        console.error(`[settings] ${this.file} could not be read (${err.message}). Using defaults.`);
      }
    }
  }

  get() {
    return this.settings;
  }

  /** Settings with secrets removed, safe to send to the admin panel. */
  getRedacted() {
    const copy = structuredClone(this.settings);
    copy.speciesSource.rcon.hasPassword = Boolean(copy.speciesSource.rcon.password);
    copy.speciesSource.rcon.password = '';
    return copy;
  }

  update(input) {
    this.settings = sanitizeSettings(input, this.settings);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.settings;
  }
}
