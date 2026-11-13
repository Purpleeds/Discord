// The colour picker: a saturation/brightness square, a hue bar, a hex box,
// an eyedropper (Chromium's EyeDropper - picks from anywhere on screen),
// presets and recently used colours. One picker, opened next to whatever
// asked for it:
//   ColourPicker.open(anchorEl, '#ffb648', { onInput(hex), onDone(hex), onCancel() })
// onInput fires while dragging (for a live preview); onDone once, when the
// person clicks Done, presses Enter or clicks elsewhere. Esc / Cancel puts
// the old colour back.
(function () {
  const $ = id => document.getElementById(id);
  const PRESETS = ['#ffb648', '#ff7a59', '#ff5d7a', '#e467e8', '#a78bfa', '#7c6cff', '#4f8cff', '#38bdf8',
    '#2dd4bf', '#3ecf8e', '#84cc16', '#facc15', '#f5f5f7', '#9aa0b4', '#2b2f45', '#0b0d16'];
  const RECENT_KEY = 'recentColours';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(r, g, b) { return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  function parseHex(text) {
    let t = String(text || '').trim().toLowerCase().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/.test(t)) t = t.split('').map(c => c + c).join('');
    return /^[0-9a-f]{6}$/.test(t) ? '#' + t : null;
  }
  function recent() { try { const r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(r) ? r.filter(parseHex).slice(0, 8) : []; } catch (_) { return []; } }
  function remember(hex) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...recent().filter(c => c !== hex)].slice(0, 8))); } catch (_) {} }

  let hsv = { h: 0, s: 0, v: 0 }, original = '#000000', handlers = {}, anchor = null, openNow = false;
  const current = () => rgbToHex(...hsvToRgb(hsv.h, hsv.s, hsv.v));

  function paint(fromHexBox) {
    const hex = current();
    $('pickSv').style.backgroundColor = rgbToHex(...hsvToRgb(hsv.h, 1, 1));
    $('pickSvThumb').style.left = (hsv.s * 100) + '%';
    $('pickSvThumb').style.top = ((1 - hsv.v) * 100) + '%';
    $('pickSvThumb').style.backgroundColor = hex;
    $('pickSvThumb').setAttribute('aria-valuetext', hex);
    $('pickHueThumb').style.left = (hsv.h / 360 * 100) + '%';
    $('pickHueThumb').style.backgroundColor = rgbToHex(...hsvToRgb(hsv.h, 1, 1));
    $('pickHueThumb').setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    $('pickNew').style.backgroundColor = hex;
    if (!fromHexBox) $('pickHex').value = hex.slice(1);
  }
  function set(hex, fromHexBox) {
    const keepHue = hsv.h;
    hsv = rgbToHsv(...hexToRgb(hex));
    if (!hsv.s || !hsv.v) hsv.h = keepHue; // greys have no hue: keep the bar where it was
    paint(fromHexBox);
    if (handlers.onInput) handlers.onInput(current());
  }
  function changed() { paint(false); if (handlers.onInput) handlers.onInput(current()); }

  function drag(el, move) {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      move(e);
      const onMove = ev => move(ev);
      const onUp = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }
  drag($('pickSv'), e => {
    const r = $('pickSv').getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    changed();
    $('pickSvThumb').focus({ preventScroll: true });
  });
  drag($('pickHue'), e => {
    const r = $('pickHue').getBoundingClientRect();
    hsv.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 359.9;
    changed();
    $('pickHueThumb').focus({ preventScroll: true });
  });
  $('pickSvThumb').addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    hsv.s = clamp(hsv.s + moves[e.key][0], 0, 1);
    hsv.v = clamp(hsv.v + moves[e.key][1], 0, 1);
    changed();
  });
  $('pickHueThumb').addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (!d) return;
    e.preventDefault();
    hsv.h = clamp(hsv.h + d, 0, 359.9);
    changed();
  });
  $('pickHex').addEventListener('input', () => { const hex = parseHex($('pickHex').value); if (hex) set(hex, true); });
  $('pickHex').addEventListener('blur', () => paint(false));
  $('pickHex').addEventListener('paste', e => {
    const hex = parseHex((e.clipboardData && e.clipboardData.getData('text')) || '');
    if (hex) { e.preventDefault(); set(hex, false); }
  });
  if (typeof window.EyeDropper === 'function') {
    $('pickDropper').addEventListener('click', async () => {
      try { const r = await new window.EyeDropper().open(); const hex = parseHex(r && r.sRGBHex); if (hex) set(hex, false); } catch (_) { /* cancelled */ }
    });
  } else $('pickDropper').hidden = true;

  function swatchButtons(box, colours) {
    box.textContent = '';
    for (const c of colours) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.backgroundColor = c;
      b.title = c;
      b.setAttribute('aria-label', 'Use ' + c);
      b.addEventListener('click', () => set(c, false));
      box.appendChild(b);
    }
  }
  swatchButtons($('pickSwatches'), PRESETS);

  function place() {
    const box = $('picker');
    const a = anchor.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = a.left, top = a.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 8);
    left = clamp(left, 8, window.innerWidth - w - 8);
    top = clamp(top, 48, Math.max(48, window.innerHeight - h - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }
  function close(commit) {
    if (!openNow) return;
    openNow = false;
    $('picker').hidden = true;
    const h = handlers; handlers = {};
    if (commit) { const hex = current(); remember(hex); if (h.onDone) h.onDone(hex); }
    else { if (h.onInput) h.onInput(original); if (h.onCancel) h.onCancel(); }
    if (anchor && document.contains(anchor)) anchor.focus({ preventScroll: true });
  }
  $('pickDone').addEventListener('click', () => close(true));
  $('pickCancel').addEventListener('click', () => close(false));
  $('picker').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); close(true); }
  });
  // clicking anywhere else keeps the colour, like most pickers
  document.addEventListener('pointerdown', e => {
    if (openNow && !$('picker').contains(e.target) && !(anchor && anchor.contains(e.target))) close(true);
  }, true);
  window.addEventListener('resize', () => { if (openNow) place(); });

  window.ColourPicker = {
    open(el, hex, opts) {
      if (openNow) close(true);
      anchor = el;
      handlers = opts || {};
      original = parseHex(hex) || '#ffb648';
      hsv = rgbToHsv(...hexToRgb(original));
      $('pickOld').style.backgroundColor = original;
      const r = recent();
      $('pickRecentWrap').hidden = !r.length;
      swatchButtons($('pickRecent'), r);
      $('picker').hidden = false;
      openNow = true;
      paint(false);
      place();
      $('pickSvThumb').focus({ preventScroll: true });
    },
    close,
    isOpen: () => openNow,
    parseHex
  };
})();
