// One pop-up card. Everything shown is set with textContent - message text
// can never become HTML here. Talks to the main process only through the
// small `notifier` API from card-preload.js.
const $ = id => document.getElementById(id);
const PALETTE = ['#e8590c', '#d6336c', '#ae3ec9', '#7048e8', '#4263eb', '#1c7ed6', '#1098ad', '#0ca678', '#37b24d', '#f59f00', '#f03e3e'];
function colourFor(name) {
  let h = 0;
  for (const c of String(name || '?')) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
let duration = 0;

function render(card) {
  document.documentElement.dataset.theme = card.theme === 'afterhours' ? '' : card.theme;
  document.documentElement.style.setProperty('--brand', card.accent);
  document.documentElement.style.setProperty('--on-brand', card.onAccent);
  $('card').classList.toggle('call', !!card.sticky);
  $('name').textContent = card.name;
  $('where').textContent = card.where;
  const count = $('count');
  count.hidden = !(card.count > 1);
  count.textContent = card.count + ' new';
  const avatar = $('avatar');
  avatar.textContent = '';
  avatar.style.background = colourFor(card.colourKey || card.name);
  const initial = () => { avatar.textContent = (String(card.name).trim().charAt(0) || '?').toUpperCase(); };
  if (card.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { img.remove(); initial(); };
    img.src = card.avatar;
    avatar.appendChild(img);
  } else initial();
  const body = $('body');
  body.textContent = '';
  for (const t of card.tags || []) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    body.appendChild(tag);
  }
  if (card.text) body.appendChild(document.createTextNode(card.text));
  $('card').setAttribute('aria-label', card.name + ', ' + card.where + (card.text ? ': ' + card.text : ''));
  duration = card.duration;
  restartTimer();
  // tell the main process how tall this card is, so the window fits it
  requestAnimationFrame(() => notifier.size(Math.ceil(document.body.getBoundingClientRect().height)));
}
function restartTimer() {
  const timer = $('timer');
  timer.classList.remove('run');
  void timer.offsetWidth;
  if (!duration) return;
  timer.style.animationDuration = duration + 'ms';
  timer.classList.add('run');
}

notifier.onCard(render);
notifier.onLeave(() => $('card').classList.add('leaving'));
$('card').addEventListener('click', e => { if (!e.target.closest('#close')) notifier.open(); });
$('close').addEventListener('click', e => { e.stopPropagation(); notifier.dismiss(); });
// hovering holds the card; leaving lets it go a little later
$('card').addEventListener('mouseenter', () => notifier.hover(true));
$('card').addEventListener('mouseleave', () => notifier.hover(false));
notifier.ready();
