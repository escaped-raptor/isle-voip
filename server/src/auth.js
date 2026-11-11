// Sign-in: signed session tokens, the admin password, and Steam OpenID.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export class Auth {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.secretFile = path.join(dataDir, 'secret.key');
    this.adminFile = path.join(dataDir, 'admin.json');
    if (!fs.existsSync(this.secretFile)) {
      fs.writeFileSync(this.secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
    }
    this.secret = fs.readFileSync(this.secretFile, 'utf8').trim();
    this.failures = new Map(); // ip -> { count, until }
  }

  // ---- tokens -------------------------------------------------------------

  sign(payload, ttlSeconds) {
    const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
    const mac = b64(crypto.createHmac('sha256', this.secret).update(body).digest());
    return `${body}.${mac}`;
  }

  verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expected = b64(crypto.createHmac('sha256', this.secret).update(body).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // ---- admin password -----------------------------------------------------

  #hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  /** Create a random admin password on first run. Returns it so it can be shown once. */
  ensureAdminPassword() {
    if (fs.existsSync(this.adminFile)) return null;
    const password = crypto.randomBytes(12).toString('base64url');
    this.setAdminPassword(password);
    return password;
  }

  setAdminPassword(password) {
    if (typeof password !== 'string' || password.length < 10) {
      throw new Error('Use a password of at least 10 characters.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(this.adminFile, JSON.stringify({ salt, hash: this.#hash(password, salt) }), { mode: 0o600 });
  }

  checkAdminPassword(password) {
    try {
      const { salt, hash } = JSON.parse(fs.readFileSync(this.adminFile, 'utf8'));
      const a = Buffer.from(this.#hash(String(password || ''), salt), 'hex');
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Slow down password guessing: 5 wrong tries locks that address out for 5 minutes. */
  loginAllowed(ip) {
    const f = this.failures.get(ip);
    return !f || f.count < 5 || f.until < Date.now();
  }

  recordLogin(ip, ok) {
    if (ok) return this.failures.delete(ip);
    const f = this.failures.get(ip);
    const fresh = !f || f.until < Date.now();
    this.failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 5 * 60_000 });
  }
}

// ---- Steam OpenID ----------------------------------------------------------
// Proves a player owns a Steam account without the server ever seeing a password.

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';

export function steamLoginUrl(publicUrl) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${publicUrl}/auth/steam/return`,
    'openid.realm': publicUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  return `${STEAM_OPENID}?${params}`;
}

/** Check Steam's answer. Returns the SteamID64 or throws. */
export async function verifySteamReturn(query, publicUrl, fetchImpl = fetch) {
  if (query['openid.mode'] !== 'id_res') throw new Error('Steam sign-in was cancelled.');
  if (!String(query['openid.return_to'] || '').startsWith(`${publicUrl}/auth/steam/return`)) {
    throw new Error('Steam sign-in returned to the wrong address.');
  }
  const match = String(query['openid.claimed_id'] || '').match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!match) throw new Error('Steam did not return a valid account.');

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k.startsWith('openid.')) body.set(k, String(v));
  body.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_OPENID, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text();
  if (!/is_valid\s*:\s*true/.test(text)) throw new Error('Steam could not confirm the sign-in.');
  return match[1];
}
