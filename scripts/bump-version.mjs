// Moves the project to its next version number and writes it everywhere it is stored.
//
// Numbering rule: the last digit counts 0 to 9, then the middle number goes up
// and the last digit starts again:  0.2.0, 0.2.1 … 0.2.9, 0.3.0, 0.3.1 …
//
// A release stage such as "Alpha" is kept in the "releaseStage" field of each
// package.json and shown after the number: v0.2.3 (Alpha). Bumping keeps it.
// Delete that field (or set it to "") when the project leaves that stage.
//
// Usage (from the repository root):   node scripts/bump-version.mjs
// The server and client GUIs read the number from their package.json, so the
// label in the bottom left updates by itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function nextVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`"${current}" is not a version like 0.2.1`);
  const [major, minor, patch] = m.slice(1).map(Number);
  return patch < 9 ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

function setVersion(file, version) {
  if (!fs.existsSync(file)) return;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version; // package-lock.json
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8')).version;
  const next = nextVersion(current);
  for (const part of ['server', 'client', 'server-app']) {
    setVersion(path.join(root, part, 'package.json'), next);
    setVersion(path.join(root, part, 'package-lock.json'), next);
  }
  const stage = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8')).releaseStage;
  const label = (v) => `v${v}${stage ? ` (${stage})` : ''}`;
  console.log(`${label(current)} -> ${label(next)}`);
}
