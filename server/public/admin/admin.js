// Admin panel. Talks to /api/admin/* with a token kept only for this tab.
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const CATS = [
    ['carnivore', 'Carnivores'],
    ['herbivore', 'Herbivores'],
    ['omnivore', 'Omnivores']
  ];
  const SCOPE_TEXT = { species: 'their own species only', category: 'any species in their category', all: 'any species' };

  let token = null;
  try { token = sessionStorage.getItem('isleVoipAdmin'); } catch {}
  let saved = null; // settings as stored on the server
  let draft = null; // settings being edited
  let openSpecies = null; // id of the species whose editor is open
  let statusTimer = null;

  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }

  async function api(method, url, body) {
    const res = await fetch('/api/admin' + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/login') {
      signOut();
      throw new Error('Sign in again.');
    }
    if (!res.ok) throw new Error(data.error || 'The server could not do that.');
    return data;
  }

  // ---- sign in / out ---------------------------------------------------------

  function signOut() {
    token = null;
    try { sessionStorage.removeItem('isleVoipAdmin'); } catch {}
    clearInterval(statusTimer);
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-pw').focus();
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    try {
      token = (await api('POST', '/login', { password: $('#login-pw').value })).token;
      try { sessionStorage.setItem('isleVoipAdmin', token); } catch {}
      $('#login-pw').value = '';
      await start();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  $('#signout').addEventListener('click', signOut);

  async function start() {
    saved = await api('GET', '/settings');
    draft = structuredClone(saved);
    $('#login').hidden = true;
    $('#app').hidden = false;
    fetch('/api/info').then((r) => r.json()).then((i) => ($('#server-name').textContent = i.name)).catch(() => {});
    renderAll();
    showTab(location.hash.slice(1) || 'players');
    refreshStatus();
    clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 4000);
  }

  // ---- tabs ------------------------------------------------------------------

  function showTab(name) {
    if (!$(`[data-page="${name}"]`)) name = 'players';
    $$('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== name));
    $$('[data-tab]').forEach((b) => (b.dataset.tab === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    history.replaceState(null, '', '#' + name);
  }
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---- unsaved changes -------------------------------------------------------

  function changed() {
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    $('#savebar').hidden = !dirty;
    if (dirty) $('#save-msg').textContent = 'You have unsaved changes.';
  }
  $('#discard').addEventListener('click', () => {
    draft = structuredClone(saved);
    openSpecies = null;
    renderAll();
    changed();
  });
  $('#save').addEventListener('click', async () => {
    try {
      // Species added in this session get their permanent id from their name.
      const body = structuredClone(draft);
      for (const s of body.species) if (s.id.startsWith('new-species')) delete s.id;
      saved = await api('PUT', '/settings', body);
      draft = structuredClone(saved);
      openSpecies = null;
      renderAll();
      changed();
      refreshStatus();
    } catch (e) {
      $('#save-msg').textContent = 'Not saved: ' + e.message;
    }
  });
  window.addEventListener('beforeunload', (ev) => {
    if (draft && JSON.stringify(draft) !== JSON.stringify(saved)) ev.preventDefault();
  });

  // ---- rules -----------------------------------------------------------------

  function scopeSelect(value, onchange, withInherit) {
    const sel = h('select', { 'aria-label': 'Who they can talk to', onchange: (e) => onchange(e.target.value) });
    if (withInherit) sel.append(h('option', { value: '', text: 'follow the category rule' }));
    for (const [v, text] of Object.entries(SCOPE_TEXT)) sel.append(h('option', { value: v, text }));
    sel.value = value ?? '';
    return sel;
  }

  function renderRules() {
    const list = $('#rules-list');
    list.textContent = '';
    for (const [cat, label] of CATS) {
      const rule = draft.categories[cat];
      list.append(
        h('div', { class: 'rule ' + cat },
          h('strong', { text: label }),
          h('span', { text: 'can talk to' }),
          scopeSelect(rule.scope, (v) => { rule.scope = v; changed(); }),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: rule.requireGroup, onchange: (e) => { rule.requireGroup = e.target.checked; changed(); } }),
            'only when in the same voice group'))
      );
    }
    $('#max-size').value = draft.groups.maxSize;
    const px = draft.proximity;
    $('#px-on').checked = px.enabled;
    $('#px-fade').checked = px.fade;
    $('#px-range').value = px.rangeMetres;
    $('#px-update').value = px.updateSeconds;
    $('#px-units').value = px.unitsPerMetre;
    for (const id of ['#px-range', '#px-update', '#px-units', '#px-fade']) $(id).disabled = !px.enabled;
    renderRangeNote();
  }

  function renderRangeNote() {
    const note = $('#px-note');
    const type = draft.speciesSource.type;
    note.hidden = !draft.proximity.enabled || type === 'rcon';
    note.textContent = type === 'legacy'
      ? 'Legacy save files only hold the position from the last save, so the range is not applied with that species check. Use RCON for proximity voice.'
      : 'In testing mode the range only applies between players who type a test position into their client.';
  }
  $('#px-on').addEventListener('change', (e) => { draft.proximity.enabled = e.target.checked; changed(); renderRules(); });
  $('#px-fade').addEventListener('change', (e) => { draft.proximity.fade = e.target.checked; changed(); });
  $('#px-range').addEventListener('input', (e) => { draft.proximity.rangeMetres = Number(e.target.value) || 0; changed(); });
  $('#px-update').addEventListener('input', (e) => { draft.proximity.updateSeconds = Number(e.target.value) || 0; changed(); });
  $('#px-units').addEventListener('input', (e) => { draft.proximity.unitsPerMetre = Number(e.target.value) || 0; changed(); });
  $('#max-size').addEventListener('input', (e) => { draft.groups.maxSize = Math.max(0, Number(e.target.value) || 0); changed(); });

  // ---- species ---------------------------------------------------------------

  function ruleSummary(s) {
    if (!s.rule) return 'Follows the ' + s.category + ' rule';
    const cat = draft.categories[s.category];
    const scope = s.rule.scope ?? cat.scope;
    const group = s.rule.requireGroup ?? cat.requireGroup;
    let text = 'Own rule: ' + SCOPE_TEXT[scope] + (group ? ', in a group' : ', no group needed');
    if (s.rule.also?.length) text += `, plus ${s.rule.also.length} other species`;
    return text;
  }

  function speciesEditor(s) {
    const own = Boolean(s.rule);
    const setRule = (patch) => { s.rule = { ...(s.rule || {}), ...patch }; changed(); renderSpecies(); };
    const others = draft.species.filter((o) => o.id !== s.id);
    const nameInput = h('input', { type: 'text', id: 'sp-name', value: s.name, maxlength: 60, oninput: (e) => { s.name = e.target.value; e.target.closest('.sp').querySelector('.name').textContent = s.name || 'Unnamed species'; changed(); } });
    const catSel = h('select', { id: 'sp-cat', onchange: (e) => { s.category = e.target.value; changed(); renderSpecies(); } },
      CATS.map(([v, t]) => h('option', { value: v, text: t.slice(0, -1) })));
    catSel.value = s.category;
    const cls = h('input', { type: 'text', id: 'sp-cls', value: s.classNames.join(', '),
      oninput: (e) => { s.classNames = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); changed(); } });

    const ruleBox = h('div', { class: 'stack' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: own, onchange: (e) => { s.rule = e.target.checked ? { ...draft.categories[s.category], also: [] } : null; changed(); renderSpecies(); } }),
        'Give this species its own rule'));
    if (own) {
      const cat = draft.categories[s.category];
      ruleBox.append(
        h('div', { class: 'rule ' + s.category },
          h('span', { text: 'Can talk to' }),
          scopeSelect(s.rule.scope ?? cat.scope, (v) => setRule({ scope: v })),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: s.rule.requireGroup ?? cat.requireGroup, onchange: (e) => setRule({ requireGroup: e.target.checked }) }),
            'only when in the same voice group')),
        h('span', { class: 'label', text: 'Also allowed to talk to (the other species must allow this one too)' }),
        h('div', { class: 'also' }, others.map((o) =>
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: (s.rule.also || []).includes(o.id), onchange: (e) => {
              const set = new Set(s.rule.also || []);
              e.target.checked ? set.add(o.id) : set.delete(o.id);
              setRule({ also: [...set] });
            } }), o.name)))
      );
    }

    return h('div', { class: 'sp-edit' },
      h('div', { class: 'cols' },
        h('div', {}, h('label', { for: 'sp-name', text: 'Name' }), nameInput),
        h('div', {}, h('label', { for: 'sp-cat', text: 'Category' }), catSel)),
      h('div', {},
        h('label', { for: 'sp-cls', text: 'Class names the game uses for it, separated by commas (BP_ and _C are ignored)' }), cls),
      ruleBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: 'Done', onclick: () => { openSpecies = null; renderSpecies(); } }),
        h('button', { class: 'btn danger', text: 'Remove species', onclick: () => {
          draft.species = draft.species.filter((o) => o !== s);
          for (const o of draft.species) if (o.rule?.also) o.rule.also = o.rule.also.filter((id) => id !== s.id);
          openSpecies = null; changed(); renderSpecies();
        } })));
  }

  function addSpecies(category, name = '', classNames) {
    let n = 1;
    let id = 'new-species';
    while (draft.species.some((s) => s.id === id)) id = 'new-species-' + ++n;
    const s = { id, name, category, classNames: classNames || (name ? [name] : []), rule: null };
    draft.species.push(s);
    openSpecies = id;
    changed();
    renderSpecies();
    showTab('species');
    const input = $('#sp-name');
    if (input) { input.focus(); input.scrollIntoView({ block: 'center' }); }
  }

  function renderSpecies() {
    const root = $('#species-lists');
    root.textContent = '';
    for (const [cat, label] of CATS) {
      const items = draft.species.filter((s) => s.category === cat);
      root.append(h('div', { class: 'cat-head' },
        h('h2', {}, label, ' ', h('span', { class: 'muted small', text: String(items.length) })),
        h('button', { class: 'btn', text: 'Add ' + label.slice(0, -1).toLowerCase(), onclick: () => addSpecies(cat) })));
      if (!items.length) root.append(h('p', { class: 'muted', text: `No ${label.toLowerCase()} yet.` }));
      for (const s of items) {
        const open = openSpecies === s.id;
        root.append(h('div', { class: 'sp' },
          h('div', { class: 'sp-row' },
            h('span', { class: 'name', text: s.name || 'Unnamed species' }),
            h('span', { class: 'muted small', text: ruleSummary(s) }),
            h('button', { class: 'btn quiet', 'aria-expanded': String(open), text: open ? 'Close' : 'Edit',
              onclick: () => { openSpecies = open ? null : s.id; renderSpecies(); } })),
          open ? speciesEditor(s) : null));
      }
    }
  }

  // ---- species check ---------------------------------------------------------

  function renderCheck() {
    const src = draft.speciesSource;
    $$('input[name="src"]').forEach((r) => (r.checked = r.value === src.type));
    $('#src-rcon').hidden = src.type !== 'rcon';
    $('#src-legacy').hidden = src.type !== 'legacy';
    $('#rcon-host').value = src.rcon.host;
    $('#rcon-port').value = src.rcon.port;
    $('#rcon-pw').value = src.rcon.password;
    $('#rcon-pw').placeholder = src.rcon.hasPassword ? 'Saved. Type to replace it.' : '';
    $('#legacy-dir').value = src.legacy.dir;
    $('#recheck').value = src.recheckSeconds;
  }
  $$('input[name="src"]').forEach((r) => r.addEventListener('change', () => { draft.speciesSource.type = r.value; renderCheck(); renderRangeNote(); changed(); }));
  const bind = (sel, fn) => $(sel).addEventListener('input', (e) => { fn(e.target.value); changed(); });
  bind('#rcon-host', (v) => (draft.speciesSource.rcon.host = v));
  bind('#rcon-port', (v) => (draft.speciesSource.rcon.port = Number(v) || 0));
  bind('#rcon-pw', (v) => (draft.speciesSource.rcon.password = v));
  bind('#legacy-dir', (v) => (draft.speciesSource.legacy.dir = v));
  bind('#recheck', (v) => (draft.speciesSource.recheckSeconds = Number(v) || 0));

  $('#test-src').addEventListener('click', async () => {
    const out = $('#test-out');
    out.hidden = false;
    out.textContent = 'Testing…';
    try {
      const r = await api('POST', '/test-source');
      const lines = r.players.map((p) => `${p.name || '(no name)'}  ${p.steamId}  ${p.className || '(no class)'}`);
      out.textContent = (r.players.length ? `Understood ${r.players.length} player(s):\n${lines.join('\n')}\n\n` : '') + 'Reply from the game server:\n' + (r.raw || '(empty)');
    } catch (e) {
      out.textContent = 'Test failed: ' + e.message;
    }
  });

  // ---- call key --------------------------------------------------------------

  $('#call-on').addEventListener('change', (e) => { draft.callMacro.enabled = e.target.checked; changed(); });
  $('#whitelist').addEventListener('input', (e) => {
    draft.testAccess = { whitelist: [...new Set(e.target.value.split(/[\s,;]+/).filter((v) => /^\d{17}$/.test(v)))].slice(0, 30) };
    changed();
  });

  // ---- players (live) --------------------------------------------------------

  const STATUS_TEXT = {
    'not-spawned': 'Not spawned',
    'unknown-species': 'Species not in your list',
    'source-down': 'Species check is failing',
    'choose-species': 'Has not picked a species'
  };

  async function refreshStatus() {
    if (!token) return;
    let st;
    try { st = await api('GET', '/status'); } catch { return; }
    const src = st.source;
    const check = src.type === 'manual' ? 'Players pick their own species (testing mode).'
      : src.ok === false ? `Species check is failing: ${src.message}`
      : src.ok ? `Species check is working. ${src.message}` : 'Species check has not run yet.';
    $('#players-summary').textContent = `${st.players.length} connected, ${st.groups} voice group${st.groups === 1 ? '' : 's'}. ${check}`;

    const unknown = $('#unknown');
    unknown.textContent = '';
    for (const cls of st.unknownClasses) {
      if (draft.species.some((s) => s.classNames.includes(cls))) continue;
      const pretty = cls.replace(/^BP_/i, '').replace(/_C$/i, '');
      unknown.append(h('div', { class: 'notice row' },
        h('span', { text: `The game reported "${cls}", which isn't in your species list. Players using it can't talk. Add it as a:` }),
        CATS.map(([cat, label]) => h('button', { class: 'btn', text: label.slice(0, -1), onclick: () => addSpecies(cat, pretty, [...new Set([pretty, cls])]) }))));
    }

    const body = $('#players-table tbody');
    body.textContent = '';
    for (const p of st.players) {
      body.append(h('tr', {},
        h('td', { text: p.name }),
        h('td', {}, p.species ? [p.species + ' ', h('span', { class: 'chip ' + p.category, text: p.category })] : h('span', { class: 'muted', text: STATUS_TEXT[p.status] || p.status })),
        h('td', { text: p.group || 'None' }),
        h('td', { text: p.hears === 1 ? '1 player' : p.hears + ' players' }),
        h('td', { class: 'id', text: p.pos ? `${p.pos.x}, ${p.pos.y}` : 'Unknown' }),
        h('td', { class: 'id', text: p.steamId })));
    }
    renderMeasure(st.players.filter((p) => p.pos));
    // HTTPS and testing status on the Server page
    const sec = st.https || {};
    const until = sec.validTo ? new Date(sec.validTo).toDateString() : '';
    const box = $('#https-status');
    box.className = 'notice' + (sec.daysLeft != null && sec.daysLeft < 14 && sec.mode === 'provided' ? ' error' : '');
    box.textContent = sec.mode === 'provided' ? `Using your certificate from ${sec.issuer}. It is valid until ${until} (${sec.daysLeft} days). Renew it before then; the server picks up the new files by itself.`
      : sec.mode === 'automatic' ? `Automatic HTTPS: a free certificate from ${sec.issuer}, valid until ${until}. It renews by itself; keep port 80 open.`
      : sec.mode === 'testing' ? 'Testing mode: no certificate, this computer only. Not for real players.'
      : 'HTTPS is provided by another program in front of this server (a reverse proxy).';
    $('#testing-box').hidden = !st.testing;
    const lost = st.players.filter((p) => p.species && !p.pos).length;
    if (st.proximity.active && st.proximity.mode === 'required' && lost) {
      unknown.append(h('div', { class: 'notice error', text: `Hearing range is on, but the game server reported no position for ${lost} spawned player${lost === 1 ? '' : 's'}, so they can't hear anyone. Run Species check, Test connection, and check the reply includes a Location.` }));
    }
    $('#players-table').hidden = !st.players.length;
    $('#players-empty').hidden = Boolean(st.players.length);
  }

  // Distance between two connected players, for setting the hearing range.
  let located = [];
  function renderMeasure(players) {
    located = players;
    $('#measure').hidden = players.length < 2;
    if (players.length < 2) return;
    for (const [id, fallback] of [['#measure-a', 0], ['#measure-b', 1]]) {
      const sel = $(id);
      const keep = sel.value;
      sel.textContent = '';
      for (const p of players) sel.append(h('option', { value: p.steamId, text: p.name }));
      sel.value = players.some((p) => p.steamId === keep) ? keep : players[fallback].steamId;
    }
    showDistance();
  }
  function showDistance() {
    const a = located.find((p) => p.steamId === $('#measure-a').value);
    const b = located.find((p) => p.steamId === $('#measure-b').value);
    $('#measure-out').textContent = a && b ? Math.round(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)) + ' m' : '';
  }
  $('#measure-a').addEventListener('change', showDistance);
  $('#measure-b').addEventListener('change', showDistance);

  // ---- server ----------------------------------------------------------------

  $('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('#pw-msg');
    try {
      await api('POST', '/password', { current: $('#pw-cur').value, next: $('#pw-new').value });
      msg.className = 'notice';
      msg.textContent = 'Password changed.';
      ev.target.reset();
    } catch (e) {
      msg.className = 'notice error';
      msg.textContent = e.message;
    }
    msg.hidden = false;
  });

  function renderAll() {
    renderRules();
    renderSpecies();
    renderCheck();
    $('#call-on').checked = draft.callMacro.enabled;
    $('#whitelist').value = (draft.testAccess?.whitelist || []).join('\n');
  }

  fetch('/api/info').then((r) => r.json()).then((i) => {
    $('#version').textContent = i.versionLabel;
    // What players need to type into their client.
    const url = new URL(i.publicUrl);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    $('#tell-address').textContent = url.hostname;
    $('#tell-port').textContent = port;
    $('#tell-note').textContent = port === '7777'
      ? 'This is the same number as the default game port, so players only need the address.'
      : `This is not the default game port (7777), so give players the port number ${port} as well as the address.`;
  }).catch(() => {});
  IsleTheme.mount($('#wheel'));
  if (token) start().catch(signOut);
  else signOut();
})();
