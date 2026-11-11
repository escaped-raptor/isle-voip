// Builds demo/Species-Specific-VoIP-Demo.html: one self-contained file that
// shows the real server setup page, admin panel and player client with
// made-up data. No server, game, microphone or internet connection is needed.
//
// It is assembled from the same GUI files the real apps use, so it cannot
// drift from them. Rebuild it after changing the GUI:
//
//   cd client && npm install     (once, for the bundler)
//   node demo/build-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../server/src/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const { build } = createRequire(path.join(repo, 'client', 'package.json'))('esbuild');

const pkg = JSON.parse(read('server', 'package.json'));
const versionLabel = `v${pkg.version}${pkg.releaseStage ? ` (${pkg.releaseStage})` : ''}`;

// Settings as the admin panel receives them (secrets never leave the server).
const settings = defaultSettings();
settings.speciesSource.type = 'rcon';
settings.speciesSource.rcon = { host: '127.0.0.1', port: 8888, password: '', hasPassword: true };

// The real client code, with the WebRTC library swapped for a stand-in.
const bundle = await build({
  entryPoints: [path.join(repo, 'client', 'src', 'renderer.js')],
  bundle: true, format: 'iife', target: 'chrome110', minify: true, write: false,
  define: { __APP_VERSION__: JSON.stringify(versionLabel) },
  alias: { 'mediasoup-client': path.join(here, 'fake-mediasoup.js') }
});
const clientJs = bundle.outputFiles[0].text;

const inScript = (js) => js.replace(/<\/script/gi, '<\\/script');
const DEMO_CSS = `
#demo-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:.6rem;z-index:1000;width:max-content;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;justify-content:center;max-width:calc(100vw - 1rem);padding:.4rem .5rem .4rem .9rem;border-radius:999px;background:var(--c1);color:var(--on-c1);font:.85rem var(--body);box-shadow:0 4px 14px rgba(0,0,0,.45)}
#demo-bar button{border:0;border-radius:999px;padding:.3rem .75rem;font:600 .8rem var(--body);background:var(--on-c1);color:var(--c1);cursor:pointer;touch-action:none}
#demo-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:6.2rem;z-index:1000;pointer-events:none;width:max-content;max-width:min(34rem,92vw);padding:.6rem .9rem;border-radius:8px;background:var(--surface-2);color:var(--text);border:1px solid var(--line);box-shadow:0 4px 14px rgba(0,0,0,.35)}
`;

/** Turn one of the real pages into a single self-contained document. */
function page(name, html, files) {
  for (const [ref, content] of Object.entries(files)) {
    const css = new RegExp(`<link rel="stylesheet" href="${ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}">`);
    const js = new RegExp(`<script src="${ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"></script>`);
    if (css.test(html)) html = html.replace(css, () => `<style>${content}</style>`);
    else if (js.test(html)) html = html.replace(js, () => `<script>${inScript(content)}</script>`);
    else throw new Error(`${name}: could not find ${ref} to inline`);
  }
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '');
  if (/(?:href|src)="(?!https?:|data:|#)[^"]+\.(?:css|js)"/.test(html)) throw new Error(`${name}: a file reference was left behind`);
  const boot = `<style>${DEMO_CSS}</style><script>window.__DEMO__=${inScript(JSON.stringify({ page: name, settings, versionLabel }))};</script><script>${inScript(read('demo', 'shim.js'))}</script>`;
  return html.replace('<head>', () => `<head>\n${boot}`);
}

const themeCss = read('shared', 'theme.css');
const themeJs = read('shared', 'theme.js');
const pages = {
  setup: page('setup', read('server', 'public', 'setup', 'index.html'), {
    '/shared/theme.css': themeCss, 'setup.css': read('server', 'public', 'setup', 'setup.css'),
    '/shared/theme.js': themeJs, 'setup.js': read('server', 'public', 'setup', 'setup.js')
  }),
  admin: page('admin', read('server', 'public', 'admin', 'index.html'), {
    '/shared/theme.css': themeCss, 'admin.css': read('server', 'public', 'admin', 'admin.css'),
    '/shared/theme.js': themeJs, 'admin.js': read('server', 'public', 'admin', 'admin.js')
  }),
  client: page('client', read('client', 'src', 'index.html'), {
    'theme.css': themeCss, 'client.css': read('client', 'src', 'client.css'), 'theme.js': themeJs, 'renderer.js': clientJs
  })
};

const menu = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Species Specific VoIP (The Isle Evrima) demo</title>
<style>${themeCss}
.menu{max-width:46rem;margin:0 auto;padding:3rem 1.25rem 4rem;display:grid;gap:1.6rem}
.menu header{display:grid;gap:.6rem}
.choices{display:grid;gap:.75rem}
.choice{display:grid;grid-template-columns:1fr auto;gap:.3rem 1.25rem;align-items:center;text-align:left;width:100%;padding:1rem 1.15rem;border:1px solid var(--line);border-left:5px solid var(--c1);border-radius:var(--radius);background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.choice:nth-child(2){border-left-color:var(--c2)}.choice:nth-child(3){border-left-color:var(--c3)}
.choice:hover{border-color:var(--muted)}
.choice strong{font:600 1.2rem var(--display)}
.choice span{grid-column:1;color:var(--muted)}
.choice em{grid-row:1 / span 2;grid-column:2;font-style:normal;font-weight:600;color:var(--c1-text)}
.menu ul{margin:0;padding-left:1.2rem;display:grid;gap:.35rem;max-width:68ch}
</style>
<script>${inScript(themeJs)}</script>
</head>
<body>
<main class="menu">
  <header>
    <h1>Species Specific VoIP (The Isle Evrima)</h1>
    <p>A click-through demo of what you get, using made-up players and a pretend server. Nothing is installed, saved or sent anywhere.</p>
  </header>
  <div class="choices">
    <button class="choice" data-open="setup"><strong>Server: first-run setup</strong><span>The few questions a server owner answers the first time: address, port, certificate, admin password.</span><em>Open</em></button>
    <button class="choice" data-open="admin"><strong>Server: admin panel</strong><span>Talk rules, hearing range, species, the species check, the call key and the colour wheel.</span><em>Open</em></button>
    <button class="choice" data-open="client"><strong>Player client</strong><span>Sign in, join a voice group, talk with push to talk or voice activation, and change settings.</span><em>Open</em></button>
  </div>
  <section>
    <h2>What is pretend here</h2>
    <ul>
      <li>The players, their species, positions and the voice group are made up.</li>
      <li>No audio is sent or played. "Hold to simulate your voice" moves the microphone meter instead of using a real microphone.</li>
      <li>Steam sign-in, the certificate and the game's call key are skipped, with a note saying what the real app does.</li>
      <li>Changes you make last until you leave the page.</li>
    </ul>
  </section>
  <p class="muted small">Every screen has a "Back to demo menu" button at the bottom.</p>
</main>
<div class="version">${versionLabel} demo</div>
<script type="application/json" id="demo-pages">${JSON.stringify(pages).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var pages = JSON.parse(document.getElementById('demo-pages').textContent);
  window.__demoOpen = function (name) {
    if (!pages[name]) return location.reload();
    document.open();
    document.write(pages[name]);
    document.close();
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (b) {
    b.addEventListener('click', function () { window.__demoOpen(b.getAttribute('data-open')); });
  });
})();
</script>
</body>
</html>
`;

const out = path.join(here, 'Species-Specific-VoIP-Demo.html');
fs.writeFileSync(out, menu);
console.log(`Wrote ${path.relative(repo, out)} (${Math.round(menu.length / 1024)} KB)`);
