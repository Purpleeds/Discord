// Screens and windows with live thumbnails; double-click or Share picks one.
const $ = id => document.getElementById(id);
let data = { sources: [], audio: false }, tab = 'screen', chosen = '';

function paint() {
  const list = data.sources.filter(s => s.kind === tab);
  if (chosen && !data.sources.some(s => s.id === chosen)) chosen = '';
  const grid = $('grid');
  grid.textContent = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'src';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(s.id === chosen));
    b.dataset.id = s.id;
    const shot = document.createElement('div');
    shot.className = 'shot';
    if (s.thumbnail) shot.style.backgroundImage = 'url("' + s.thumbnail + '")';
    const label = document.createElement('div');
    label.className = 'label';
    if (s.icon) { const i = document.createElement('img'); i.src = s.icon; i.alt = ''; label.appendChild(i); }
    const name = document.createElement('span');
    name.textContent = s.name;
    name.title = s.name;
    label.appendChild(name);
    b.append(shot, label);
    b.onclick = () => { chosen = s.id; paint(); };
    b.ondblclick = () => { chosen = s.id; go(); };
    grid.appendChild(b);
  }
  $('empty').hidden = list.length > 0;
  grid.hidden = list.length === 0;
  $('go').disabled = !chosen;
  $('tabScreens').setAttribute('aria-selected', String(tab === 'screen'));
  $('tabWindows').setAttribute('aria-selected', String(tab === 'window'));
}
function go() { if (chosen) window.picker.choose(chosen, $('audio').checked); }

window.picker.onSources(d => {
  const first = !data.sources.length;
  data = d || { sources: [] };
  if (first) {
    $('audio').disabled = !data.audioPossible;
    $('audio').closest('label').hidden = !data.audioPossible;
    if (!data.sources.some(s => s.kind === 'screen')) tab = 'window';
  }
  if (data.tokens) for (const [k, v] of Object.entries(data.tokens)) document.documentElement.style.setProperty(k, v);
  paint();
});
$('tabScreens').onclick = () => { tab = 'screen'; paint(); };
$('tabWindows').onclick = () => { tab = 'window'; paint(); };
$('go').onclick = go;
$('cancel').onclick = () => window.picker.cancel();
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.picker.cancel(); if (e.key === 'Enter') go(); });
window.picker.ready();
