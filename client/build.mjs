// Builds the client page into dist/ (used by the desktop app and, if you
// like, served by the voice server as a web client at /play/).
import { build } from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });
const { version, releaseStage } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const label = `v${version}${releaseStage ? ` (${releaseStage})` : ''}`; // shown bottom left, e.g. v0.2.3 (Alpha)
await build({ define: { __APP_VERSION__: JSON.stringify(label) }, entryPoints: ['src/renderer.js'], bundle: true, format: 'iife', target: 'chrome120', minify: true, outfile: 'dist/renderer.js' });
for (const f of ['index.html', 'client.css']) fs.copyFileSync(`src/${f}`, `dist/${f}`);
for (const f of ['theme.js', 'theme.css']) fs.copyFileSync(`../shared/${f}`, `dist/${f}`);
console.log('Built client into dist/');
