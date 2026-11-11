// Colour theme for Species Specific VoIP (The Isle Evrima): a colour wheel with a draggable handle and
// selectable harmonies of 2 to 5 colours. Used by both the admin panel and
// the player client. The choice is saved per person, in their own browser.
(function () {
  'use strict';

  var KEY = 'isleVoipTheme';
  var HARMONIES = {
    complementary: { label: 'Complementary', offsets: [0, 180] },
    analogous: { label: 'Analogous', offsets: [0, 30, -30] },
    triadic: { label: 'Triadic', offsets: [0, 120, 240] },
    split: { label: 'Split complementary', offsets: [0, 150, 210] },
    tetradic: { label: 'Tetradic (rectangle)', offsets: [0, 60, 180, 240] },
    square: { label: 'Square', offsets: [0, 90, 180, 270] },
    analogous5: { label: 'Wide analogous', offsets: [0, 25, -25, 50, -50] },
    pentadic: { label: 'Pentadic', offsets: [0, 72, 144, 216, 288] }
  };
  var DEFAULT = { h: 34, s: 78, l: 58, harmony: 'triadic', mode: 'dark' };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function mod(v, n) { return ((v % n) + n) % n; }

  function load() {
    try {
      var t = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (t && HARMONIES[t.harmony]) {
        return {
          h: mod(Number(t.h) || 0, 360),
          s: clamp(Number(t.s) || 0, 0, 100),
          l: clamp(Number(t.l) || 50, 30, 75),
          harmony: t.harmony,
          mode: t.mode === 'light' ? 'light' : 'dark'
        };
      }
    } catch (e) { /* storage unavailable: fall back to the default theme */ }
    return Object.assign({}, DEFAULT);
  }

  function save(t) {
    try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) { /* not saved; still applied for this visit */ }
  }

  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function hex(rgb) {
    return '#' + rgb.map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  /** The harmony's colours as [{h, s, l, css, hex, on}]. */
  function palette(t) {
    return HARMONIES[t.harmony].offsets.map(function (off) {
      var h = mod(t.h + off, 360);
      var rgb = hslToRgb(h, t.s, t.l);
      return {
        h: h, s: t.s, l: t.l,
        css: 'hsl(' + Math.round(h) + ' ' + Math.round(t.s) + '% ' + Math.round(t.l) + '%)',
        hex: hex(rgb),
        // readable text colour to put on top of this colour
        on: luminance(rgb) > 0.36 ? 'hsl(' + Math.round(h) + ' 40% 8%)' : '#ffffff'
      };
    });
  }

  function apply(t) {
    var root = document.documentElement;
    var cols = palette(t);
    for (var i = 0; i < 5; i++) {
      var c = cols[i % cols.length]; // fewer than 5 colours: reuse them in order
      root.style.setProperty('--c' + (i + 1), c.css);
      root.style.setProperty('--on-c' + (i + 1), c.on);
      // a version of each colour that stays readable as text on the background
      var textL = t.mode === 'dark' ? Math.max(c.l, 66) : Math.min(c.l, 36);
      root.style.setProperty('--c' + (i + 1) + '-text', 'hsl(' + Math.round(c.h) + ' ' + Math.round(Math.max(c.s, 35)) + '% ' + textL + '%)');
    }
    var h = Math.round(t.h);
    var tint = Math.round(Math.min(t.s, 100) * 0.22);
    var dark = t.mode === 'dark';
    root.style.setProperty('--bg', 'hsl(' + h + ' ' + tint + '% ' + (dark ? 8 : 95) + '%)');
    root.style.setProperty('--surface', 'hsl(' + h + ' ' + tint + '% ' + (dark ? 12 : 99) + '%)');
    root.style.setProperty('--surface-2', 'hsl(' + h + ' ' + tint + '% ' + (dark ? 17 : 91) + '%)');
    root.style.setProperty('--line', 'hsl(' + h + ' ' + tint + '% ' + (dark ? 26 : 80) + '%)');
    root.style.setProperty('--text', 'hsl(' + h + ' ' + Math.round(tint * 0.8) + '% ' + (dark ? 92 : 12) + '%)');
    root.style.setProperty('--muted', 'hsl(' + h + ' ' + Math.round(tint * 0.6) + '% ' + (dark ? 66 : 36) + '%)');
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.dataset.mode = t.mode;
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  /** Build the colour picker inside `host`. */
  function mount(host) {
    var t = load();
    var SIZE = 280;
    var R = SIZE / 2;
    var INNER = R - 14; // radius at 100% saturation

    var canvas = el('canvas', { width: SIZE, height: SIZE, 'aria-hidden': 'true' });
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + SIZE + ' ' + SIZE);
    svg.setAttribute('aria-hidden', 'true');
    var handle = el('button', {
      type: 'button', class: 'tw-handle', role: 'slider', 'aria-label': 'Base colour. Drag, or use the arrow keys: left and right change hue, up and down change saturation.',
      'aria-valuemin': '0', 'aria-valuemax': '360'
    });
    var wheel = el('div', { class: 'tw-wheel' }, [canvas, svg, handle]);

    var harmony = el('select', { id: 'tw-harmony' });
    [2, 3, 4, 5].forEach(function (n) {
      var group = el('optgroup', { label: n + ' colours' });
      Object.keys(HARMONIES).forEach(function (k) {
        if (HARMONIES[k].offsets.length === n) group.appendChild(el('option', { value: k, text: HARMONIES[k].label + ' (' + n + ')' }));
      });
      harmony.appendChild(group);
    });
    var light = el('input', { id: 'tw-light', type: 'range', min: '30', max: '75', step: '1' });
    var modeDark = el('button', { type: 'button', class: 'seg', text: 'Dark' });
    var modeLight = el('button', { type: 'button', class: 'seg', text: 'Light' });
    var swatches = el('div', { class: 'tw-swatches', role: 'list' });
    var reset = el('button', { type: 'button', class: 'btn quiet', text: 'Reset to default colours' });

    var controls = el('div', { class: 'tw-controls' }, [
      el('label', { for: 'tw-harmony', text: 'Colour harmony' }), harmony,
      el('label', { for: 'tw-light', text: 'Brightness' }), light,
      el('span', { class: 'label', text: 'Background' }),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Background' }, [modeDark, modeLight]),
      el('span', { class: 'label', text: 'Your colours' }), swatches,
      reset
    ]);
    host.classList.add('tw');
    host.appendChild(wheel);
    host.appendChild(controls);

    var ctx = canvas.getContext('2d');
    var drawnL = null;
    function drawWheel() {
      if (drawnL === t.l) return;
      drawnL = t.l;
      var img = ctx.createImageData(SIZE, SIZE);
      for (var y = 0; y < SIZE; y++) {
        for (var x = 0; x < SIZE; x++) {
          var dx = x - R + 0.5, dy = y - R + 0.5;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d > INNER + 1.5) continue;
          var hue = mod(Math.atan2(dy, dx) * 180 / Math.PI + 90, 360); // 0 degrees (red) at the top
          var rgb = hslToRgb(hue, clamp(d / INNER, 0, 1) * 100, t.l);
          var i = (y * SIZE + x) * 4;
          img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
          img.data[i + 3] = d > INNER ? Math.round(255 * clamp(INNER + 1.5 - d, 0, 1)) : 255; // soft edge
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    function pos(h, s) {
      var a = (h - 90) * Math.PI / 180;
      var r = (s / 100) * INNER;
      return [R + Math.cos(a) * r, R + Math.sin(a) * r];
    }

    function render() {
      drawWheel();
      var cols = palette(t);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      cols.forEach(function (c, i) {
        var p = pos(c.h, c.s);
        var line = document.createElementNS(svg.namespaceURI, 'line');
        line.setAttribute('x1', R); line.setAttribute('y1', R);
        line.setAttribute('x2', p[0]); line.setAttribute('y2', p[1]);
        svg.appendChild(line);
        if (i > 0) {
          var dot = document.createElementNS(svg.namespaceURI, 'circle');
          dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]); dot.setAttribute('r', 8);
          dot.setAttribute('fill', c.css);
          svg.appendChild(dot);
        }
      });
      var hp = pos(t.h, t.s);
      handle.style.left = (hp[0] / SIZE * 100) + '%';
      handle.style.top = (hp[1] / SIZE * 100) + '%';
      handle.style.background = cols[0].css;
      handle.setAttribute('aria-valuenow', Math.round(t.h));
      handle.setAttribute('aria-valuetext', 'Hue ' + Math.round(t.h) + ' degrees, saturation ' + Math.round(t.s) + ' percent');

      harmony.value = t.harmony;
      light.value = t.l;
      modeDark.setAttribute('aria-pressed', String(t.mode === 'dark'));
      modeLight.setAttribute('aria-pressed', String(t.mode === 'light'));
      swatches.textContent = '';
      cols.forEach(function (c) {
        var s = el('span', { class: 'tw-swatch', role: 'listitem', text: c.hex });
        s.style.background = c.css;
        s.style.color = c.on;
        swatches.appendChild(s);
      });
    }

    function commit() { apply(t); save(t); render(); }

    function fromPointer(ev) {
      var rect = canvas.getBoundingClientRect();
      var scale = SIZE / rect.width;
      var dx = (ev.clientX - rect.left) * scale - R;
      var dy = (ev.clientY - rect.top) * scale - R;
      t.h = mod(Math.atan2(dy, dx) * 180 / Math.PI + 90, 360);
      t.s = clamp(Math.sqrt(dx * dx + dy * dy) / INNER * 100, 0, 100);
      commit();
    }

    var dragging = false;
    wheel.addEventListener('pointerdown', function (ev) {
      dragging = true;
      wheel.setPointerCapture(ev.pointerId);
      handle.focus();
      fromPointer(ev);
      ev.preventDefault();
    });
    wheel.addEventListener('pointermove', function (ev) { if (dragging) fromPointer(ev); });
    wheel.addEventListener('pointerup', function () { dragging = false; });
    wheel.addEventListener('pointercancel', function () { dragging = false; });
    handle.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 10 : 2;
      if (ev.key === 'ArrowLeft') t.h = mod(t.h - step, 360);
      else if (ev.key === 'ArrowRight') t.h = mod(t.h + step, 360);
      else if (ev.key === 'ArrowUp') t.s = clamp(t.s + step, 0, 100);
      else if (ev.key === 'ArrowDown') t.s = clamp(t.s - step, 0, 100);
      else return;
      ev.preventDefault();
      commit();
    });
    harmony.addEventListener('change', function () { t.harmony = harmony.value; commit(); });
    light.addEventListener('input', function () { t.l = Number(light.value); commit(); });
    modeDark.addEventListener('click', function () { t.mode = 'dark'; commit(); });
    modeLight.addEventListener('click', function () { t.mode = 'light'; commit(); });
    reset.addEventListener('click', function () { t = Object.assign({}, DEFAULT); commit(); });

    render();
  }

  apply(load()); // apply the saved theme as soon as this script loads
  window.IsleTheme = { mount: mount, palette: palette, load: load, apply: apply, HARMONIES: HARMONIES };
})();
