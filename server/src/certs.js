// Certificates. Two jobs:
//  1. Check that a certificate an admin provides is one players' computers will
//     trust: issued by a publicly trusted certificate authority (free or paid),
//     for the right address, in date, and matching its private key.
//     Self-signed and private-CA certificates are refused.
//  2. Automatic HTTPS: when no certificate is provided, get a free one from
//     Let's Encrypt for the voice address and keep it renewed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const day = 24 * 3600 * 1000;
const org = (subject) => (String(subject).match(/(?:^|\n)O=([^\n]+)/) || String(subject).match(/(?:^|\n)CN=([^\n]+)/) || [])[1] || 'unknown';

/**
 * Inspect a certificate chain and key. Returns { issuer, validFrom, validTo, daysLeft }.
 * Throws an Error with a message an admin can act on.
 * The trusted list is the one built into Node.js (Mozilla's root programme,
 * the same authorities browsers trust). extraRoots is for tests only.
 */
export function inspectCertificate({ certPem, keyPem, host, extraRoots = [], now = Date.now() }) {
  const pems = String(certPem || '').match(PEM) || [];
  if (!pems.length) throw new Error('That file does not contain a certificate. Use the "full chain" file (fullchain.pem or a .crt with the intermediate certificates).');
  let chain;
  try {
    chain = pems.map((p) => new crypto.X509Certificate(p));
  } catch {
    throw new Error('The certificate file could not be read. It should be a text (PEM) file.');
  }
  const leaf = chain[0];

  if (keyPem != null) {
    let key;
    try {
      key = crypto.createPrivateKey(keyPem);
    } catch {
      throw new Error('The private key file could not be read. It should be an unencrypted text (PEM) file.');
    }
    if (!leaf.checkPrivateKey(key)) throw new Error('The private key does not belong to this certificate. Choose the key that was created with it.');
  }

  const from = new Date(leaf.validFrom).getTime();
  const to = new Date(leaf.validTo).getTime();
  if (now < from) throw new Error(`This certificate is not valid until ${new Date(from).toDateString()}. Check this computer's clock.`);
  if (now > to) throw new Error(`This certificate expired on ${new Date(to).toDateString()}. Renew it, or choose automatic HTTPS.`);
  if (host && !leaf.checkHost(host)) throw new Error(`This certificate is for a different address, not ${host}. It must be issued for the voice address players use.`);

  // Follow the chain up to an authority the public trusts.
  const roots = [...tls.rootCertificates, ...extraRoots].map((p) => new crypto.X509Certificate(p));
  const signedBy = (cert, issuer) => cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  const rest = chain.slice(1);
  let current = leaf;
  let trusted = false;
  for (let depth = 0; depth < 8 && !trusted; depth++) {
    if (roots.some((r) => r.fingerprint256 === current.fingerprint256 || signedBy(current, r))) trusted = true;
    else {
      const next = rest.find((c) => c !== current && signedBy(current, c));
      if (!next) break;
      current = next;
    }
  }
  if (!trusted) {
    const self = signedBy(leaf, leaf);
    throw new Error(
      self
        ? 'This is a self-signed certificate. Players\' computers will not trust it. Use one from a recognised certificate authority, or choose automatic HTTPS for a free one.'
        : `This certificate was issued by "${org(leaf.issuer)}", which is not a publicly trusted certificate authority (or the file is missing its intermediate certificates: use the full chain file). Use one from a recognised authority, or choose automatic HTTPS for a free one.`
    );
  }
  return { issuer: org(leaf.issuer), validFrom: new Date(from).toISOString(), validTo: new Date(to).toISOString(), daysLeft: Math.floor((to - now) / day) };
}

/** Read and check the certificate files named in the config. */
export function loadCertificate({ certFile, keyFile, host, extraRoots }) {
  let certPem, keyPem;
  try {
    certPem = fs.readFileSync(certFile, 'utf8');
  } catch {
    throw new Error(`Can't read the certificate file at ${certFile}.`);
  }
  try {
    keyPem = fs.readFileSync(keyFile, 'utf8');
  } catch {
    throw new Error(`Can't read the private key file at ${keyFile}.`);
  }
  return { cert: certPem, key: keyPem, info: inspectCertificate({ certPem, keyPem, host, extraRoots }) };
}

// ---- automatic HTTPS (Let's Encrypt) ---------------------------------------

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_TERMS = 'https://letsencrypt.org/repository/';

/**
 * Make sure there is a current certificate for `host` in `dir`, getting or
 * renewing one from the ACME authority when needed. Returns { cert, key, info, renewed }.
 *
 * To prove the address is yours, the authority fetches a small file from
 * http://<host>/ on port 80, so port 80 must reach this server while this runs.
 */
export async function ensureAutoCertificate({ dir, host, email, directoryUrl = LETS_ENCRYPT, challengePort = 80, extraRoots, log = () => {}, force = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, `${host}.fullchain.pem`);
  const keyFile = path.join(dir, `${host}.key.pem`);

  if (!force && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try {
      const have = loadCertificate({ certFile, keyFile, host, extraRoots });
      const lifetime = new Date(have.info.validTo) - new Date(have.info.validFrom);
      // Renew once a third of its life is left, as Let's Encrypt advises.
      if (new Date(have.info.validTo) - Date.now() > lifetime / 3) return { ...have, renewed: false };
      log(`The certificate for ${host} has ${have.info.daysLeft} days left. Renewing it.`);
    } catch (err) {
      log(`The saved certificate can't be used (${err.message}) Getting a new one.`);
    }
  }

  const { default: acme } = await import('acme-client');
  // Fail within about 20 seconds when the authority can't be reached, instead of retrying for over a minute.
  Object.assign(acme.axios.defaults.acmeSettings || (acme.axios.defaults.acmeSettings = {}), { retryMaxAttempts: 2, retryDefaultDelay: 3 });
  acme.axios.defaults.timeout = 15000;
  const accountFile = path.join(dir, 'account.key.pem');
  if (!fs.existsSync(accountFile)) fs.writeFileSync(accountFile, await acme.crypto.createPrivateKey(), { mode: 0o600 });
  const client = new acme.Client({ directoryUrl, accountKey: fs.readFileSync(accountFile) });
  const [key, csr] = await acme.crypto.createCsr({ altNames: [host] });

  // A tiny web server that answers the authority's check, only while it is needed.
  const answers = new Map();
  const responder = http.createServer((req, res) => {
    const token = (req.url || '').match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/)?.[1];
    if (token && answers.has(token)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(answers.get(token));
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise((resolve, reject) => {
      responder.once('error', reject);
      responder.listen(challengePort, resolve);
    });
  } catch (err) {
    const why = err.code === 'EADDRINUSE' ? `port ${challengePort} is being used by another program (stop it, or let that program handle HTTPS and choose the reverse proxy option)`
      : err.code === 'EACCES' ? `this account is not allowed to use port ${challengePort} (on Linux, run with permission to bind low ports)` : err.message;
    throw new Error(`Automatic HTTPS needs port ${challengePort} for a moment to prove the address is yours, but ${why}.`);
  }

  try {
    log(`Getting a certificate for ${host}…`);
    const cert = await client.auto({
      csr,
      email: email || undefined,
      termsOfServiceAgreed: true, // the admin agreed on the setup page; recorded in config as tls.auto.agreedToTerms
      challengePriority: ['http-01'],
      skipChallengeVerification: challengePort !== 80,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => { answers.set(challenge.token, keyAuthorization); },
      challengeRemoveFn: async (_authz, challenge) => { answers.delete(challenge.token); }
    });
    const info = inspectCertificate({ certPem: cert, keyPem: key, host, extraRoots });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.writeFileSync(certFile, cert);
    log(`Got a certificate for ${host} from ${info.issuer}, valid until ${new Date(info.validTo).toDateString()}.`);
    return { cert: String(cert), key: String(key), info, renewed: true };
  } catch (err) {
    throw new Error(`Could not get a certificate for ${host}. Check that the address points at this server and that port ${challengePort} is open to the internet, then try again. (${String(err.message).slice(0, 300)})`);
  } finally {
    responder.closeAllConnections?.();
    await new Promise((r) => responder.close(r));
  }
}
