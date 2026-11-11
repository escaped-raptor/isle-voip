// Gathers everything the server app needs into stage/ before it is packaged:
// the server code and its libraries, the shared theme, and the web client.
//
//   node build.mjs                 package for the system you are on
//   node build.mjs --win           package for Windows from Linux or macOS
//                                  (fetches the Windows media worker)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const stage = path.join(here, 'stage');
const forWindows = process.argv.includes('--win') || process.platform === 'win32';

const serverModules = path.join(repo, 'server', 'node_modules');
if (!fs.existsSync(path.join(serverModules, 'mediasoup'))) {
  console.error('Run "npm install" in the server folder first.');
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter });

// server code
for (const item of ['src', 'public', 'package.json', 'config.example.json']) copy(path.join(repo, 'server', item), path.join(stage, 'server', item));
// its libraries, leaving out mediasoup's C++ sources (only the built worker is needed)
const workerDir = path.join(serverModules, 'mediasoup', 'worker');
const releaseDir = path.join(workerDir, 'out', 'Release');
copy(serverModules, path.join(stage, 'server', 'node_modules'), (src) => {
  if (path.basename(src) === '.bin') return false;
  if (src === workerDir || src === path.join(workerDir, 'out') || src === releaseDir) return true;
  if (src.startsWith(workerDir + path.sep)) return path.dirname(src) === releaseDir && path.basename(src).startsWith('mediasoup-worker');
  return !src.startsWith(path.join(serverModules, 'mediasoup', 'rust'));
});
copy(path.join(repo, 'shared'), path.join(stage, 'shared'));

// the web client, if it has been built (optional)
const clientDist = path.join(repo, 'client', 'dist');
fs.mkdirSync(path.join(stage, 'client'), { recursive: true });
if (fs.existsSync(path.join(clientDist, 'index.html'))) copy(clientDist, path.join(stage, 'client', 'dist'));
else console.log('Note: client/dist not found, so the web client will not be included. Run "npm run build" in the client folder to include it.');

// Cross-building for Windows: swap in the Windows media worker.
const stagedRelease = path.join(stage, 'server', 'node_modules', 'mediasoup', 'worker', 'out', 'Release');
if (forWindows && process.platform !== 'win32') {
  const { version } = JSON.parse(fs.readFileSync(path.join(serverModules, 'mediasoup', 'package.json'), 'utf8'));
  const url = `https://github.com/versatica/mediasoup/releases/download/${version}/mediasoup-worker-${version}-win32-x64.tgz`;
  console.log(`Fetching the Windows media worker ${version}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
  fs.rmSync(stagedRelease, { recursive: true, force: true });
  fs.mkdirSync(stagedRelease, { recursive: true });
  const tgz = path.join(stage, 'worker.tgz');
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xzf', tgz, '-C', stagedRelease]);
  fs.rmSync(tgz);
}
const worker = path.join(stagedRelease, forWindows ? 'mediasoup-worker.exe' : 'mediasoup-worker');
if (!fs.existsSync(worker)) throw new Error(`The media worker is missing at ${worker}`);
console.log(`Staged the server app (${forWindows ? 'Windows' : process.platform}) in stage/`);
