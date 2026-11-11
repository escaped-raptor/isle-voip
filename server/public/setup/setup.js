// First-run setup page. Sends the answers to the server on this computer.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const key = new URLSearchParams(location.hash.slice(1)).get('key') || '';
  const bridge = window.serverApp || null; // present inside the server desktop app

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-key': key }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That did not work.');
    return data;
  }

  const mode = () => $('input[name="mode"]:checked').value;
  function showFields() {
    for (const el of $$('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(mode());
    $('#test-note').hidden = mode() !== 'test';
  }
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', showFields));
  showFields();

  $('#detect').addEventListener('click', async () => {
    const note = $('#detect-note');
    note.textContent = 'Looking it up…';
    try {
      $('#publicIp').value = (await post('/api/setup/detect-ip')).ip;
      note.textContent = 'Found. Check it matches what your host shows for this server.';
    } catch (e) {
      note.textContent = e.message;
    }
  });

  // In the desktop app, "Browse" opens a normal file picker.
  if (bridge) {
    $('#version').textContent = bridge.versionLabel || '';
    for (const btn of $$('[data-pick]')) {
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        const file = await bridge.pickFile();
        if (file) $('#' + btn.dataset.pick).value = file;
      });
    }
  }

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#error');
    err.hidden = true;
    const fail = (msg) => { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: 'center' }); };
    if ($('#password').value !== $('#password2').value) return fail('The two passwords are not the same.');
    $('#save').disabled = true;
    const label = $('#save').textContent;
    if (mode() === 'auto') $('#save').textContent = 'Getting your certificate… this can take a minute';
    try {
      const out = await post('/api/setup', {
        name: $('#name').value, mode: mode(), address: $('#address').value, port: $('#port').value,
        publicPort: $('#publicPort').value, publicIp: $('#publicIp').value, cert: $('#cert').value, key: $('#key').value,
        audioPort: $('#audioPort').value, password: $('#password').value,
        email: $('#email').value, agree: $('#agree').checked, whitelist: $('#whitelist').value
      });
      if (out.https) {
        $('#done-https').hidden = false;
        $('#done-https').textContent = `HTTPS is on with a certificate from ${out.https.issuer}, valid until ${new Date(out.https.validTo).toDateString()}. It renews by itself; keep port 80 open.`;
      }
      const pub = new URL(out.publicUrl);
      const playerPort = pub.port || (pub.protocol === 'https:' ? '443' : '80');
      $('#done-ports').textContent = `${out.port} (TCP) and ${out.audioPort} (UDP and TCP)` + (out.https ? ', plus 80 (TCP) for certificate renewals' : '');
      $('#done-address').textContent = pub.hostname;
      $('#done-port-note').textContent = playerPort === '7777' ? '. It uses the same port number as the game, so they only need the address' : ` and the port number ${playerPort}`;
      $('#done-public').textContent = out.publicUrl;
      $('#done-local').href = out.localUrl;
      if (out.testing) {
        $('#done-real').hidden = true;
        $('#done-public-line').hidden = true;
        $('#done-test').hidden = false;
        $('#done-test-address').textContent = 'http://localhost';
        $('#done-test-port').textContent = String(out.port) === '7777' ? ' and leave the port empty' : ` and ${out.port} as the port`;
      }
      $('#form').hidden = true;
      $('#done').hidden = false;
      $('#done').scrollIntoView();
      if (bridge) bridge.setupFinished();
    } catch (e) {
      fail(e.message);
      $('#save').disabled = false;
      $('#save').textContent = label;
    }
  });
})();
