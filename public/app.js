import { renderMarkdown, toolTarget } from '/render.js';
import { ansiSegments } from '/ansi.js';
import { COLUMNS, groupByColumn, formatDuration, titleCount, titleFor, nextWaiting, formatAgo } from '/dashboard.js';

const status = document.getElementById('status');
const conv = document.getElementById('conv');
const statusLineEl = document.getElementById('statusline');
const stateEl = document.getElementById('state');
const interruptBtn = document.getElementById('interrupt');
interruptBtn.onclick = () => send({ type: 'interrupt' });
const drawer = document.getElementById('drawer');
const toggle = document.getElementById('toggle-term');
const dash = document.getElementById('dash');
const sess = document.getElementById('sess');
const backLink = document.getElementById('back');
const projName = document.getElementById('proj-name');
const notifBtn = document.getElementById('notif');
const picker = document.getElementById('picker');
const resumeBtn = document.getElementById('resume-btn');

const term = new window.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000 });
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

const nterm = new window.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 0 });
const nfit = new window.FitAddon.FitAddon();
nterm.loadAddon(nfit);
nterm.open(document.getElementById('nvim-term'));

function setDrawer(open) {
  drawer.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) { fit.fit(); term.focus(); }
}
toggle.onclick = () => setDrawer(!drawer.classList.contains('open'));

let ws = null;
let msgEls = new Map();   // msgId -> élément .body
let toolEls = new Map();  // toolUseId -> <details>
let cards = [];           // dernier flux global reçu
let seeded = false;       // la première liste reçue ne déclenche aucune notification
let current = null;       // projet affiché dans la vue session (null = tableau de bord)
let selected = null;      // carte sélectionnée au clavier
let pendingEl = null;     // prompt envoyé, pas encore lu dans le transcript

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function bodyFor(item) {
  let body = msgEls.get(item.msgId);
  if (!body) {
    const wrap = el('div', `msg ${item.role}`);
    body = el('div', 'body');
    wrap.append(body);
    conv.append(wrap);
    msgEls.set(item.msgId, body);
  }
  return body;
}

function addItem(item) {
  if (item.kind === 'tool_result') {
    const d = toolEls.get(item.toolUseId);
    const pre = el('pre', `result${item.isError ? ' error' : ''}`, item.text || '(vide)');
    if (d) {
      if (item.isError) d.classList.add('error');
      d.append(pre);
    } else {
      const orphan = el('details', 'tool');
      orphan.append(el('summary', null, 'Résultat d\'outil'), pre);
      conv.append(orphan);
    }
    return;
  }
  const body = bodyFor(item);
  if (item.kind === 'text') {
    if (item.role === 'user') {
      body.append(el('div', null, item.text));
    } else {
      const d = el('div', 'md');
      d.innerHTML = renderMarkdown(item.text); // assaini par DOMPurify (render.js)
      body.append(d);
    }
  } else if (item.kind === 'thinking') {
    const d = el('details', 'think');
    d.append(el('summary', null, 'Réflexion'), el('pre', null, item.text));
    body.append(d);
  } else if (item.kind === 'tool_use') {
    const d = el('details', 'tool');
    const s = el('summary');
    s.append(el('span', 'name', item.name), document.createTextNode(toolTarget(item.name, item.input)));
    d.append(s, el('pre', null, JSON.stringify(item.input, null, 2)));
    body.append(d);
    toolEls.set(item.toolUseId, d);
  }
}

const isUserPrompt = (it) => it.kind === 'text' && it.role === 'user'
  && !String(it.text).startsWith('[Request interrupted by user');

function addItems(items) {
  const stick = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
  // La ligne utilisateur du transcript remplace l'affichage provisoire (même règle que session.js).
  if (pendingEl && items.some(isUserPrompt)) { pendingEl.remove(); pendingEl = null; }
  for (const it of items) addItem(it);
  if (stick) conv.scrollTop = conv.scrollHeight;
}

/** Barre de statut de claude (sortie de la statusLine de l'utilisateur, couleurs ANSI comprises). */
function showStatusLine(text) {
  const nodes = ansiSegments(text).map((s) => {
    const span = el('span', null, s.text);
    if (s.color) span.style.color = s.color;
    if (s.bold) span.style.fontWeight = 'bold';
    return span;
  });
  statusLineEl.replaceChildren(...nodes);
  statusLineEl.hidden = !text.trim();
}

/** Prompt envoyé depuis Neovim, affiché avant que claude ne l'écrive dans le JSONL. */
function showPending(text) {
  if (pendingEl) pendingEl.remove();
  pendingEl = el('div', 'msg user pending');
  pendingEl.append(el('div', 'body', text));
  conv.append(pendingEl);
  conv.scrollTop = conv.scrollHeight;
}

const STATE_LABELS = {
  running: 'en cours', needs_you: 'besoin de toi', done_unread: 'terminé', idle: 'au repos',
  error: 'erreur', stopped: 'non lancé',
};

function showState(msg) {
  stateEl.dataset.state = msg.state;
  stateEl.textContent = STATE_LABELS[msg.state] ?? msg.state;
  if (msg.activity) stateEl.textContent += ` · ${msg.activity}`;
  interruptBtn.disabled = msg.state !== 'running';
  if (msg.state === 'needs_you') setDrawer(true);
  if (msg.state === 'done_unread' && document.hasFocus()) send({ type: 'read' });
}
window.addEventListener('focus', () => {
  if (current && stateEl.dataset.state === 'done_unread') send({ type: 'read' });
});

// ---------- Tableau de bord ----------

let durEls = []; // [{el, since}] rafraîchis chaque seconde

function tickDurations() {
  const now = Date.now();
  for (const d of durEls) d.el.textContent = d.since == null ? '' : formatDuration(now - d.since);
}
setInterval(tickDurations, 1000);

function displayOrder() {
  const g = groupByColumn(cards);
  return COLUMNS.flatMap((c) => g[c.id]);
}

function makeCard(c) {
  const a = el('article', `card${c.project === selected ? ' selected' : ''}`);
  a.dataset.state = c.state;
  a.dataset.project = c.project;
  a.tabIndex = 0;
  const head = el('div', 'head');
  const dur = el('span', 'dur');
  head.append(el('span', 'proj', c.project), el('span', 'branch', c.branch ?? ''), dur);
  durEls.push({ el: dur, since: c.state === 'stopped' ? null : c.since });
  a.append(head, el('div', 'label', STATE_LABELS[c.state] ?? c.state));
  if (c.activity) a.append(el('div', 'act', c.activity));
  if (c.excerpt) a.append(el('div', 'exc', c.excerpt));
  a.onclick = () => openProject(c.project);
  a.onkeydown = (ev) => { if (ev.key === 'Enter') openProject(c.project); };
  return a;
}

function renderDash() {
  durEls = [];
  const g = groupByColumn(cards);
  const cols = COLUMNS.map((c) => {
    const col = el('section', `col ${c.id}`);
    const h = el('h2', null, c.label);
    h.append(el('span', 'n', String(g[c.id].length)));
    col.append(h);
    for (const card of g[c.id]) col.append(makeCard(card));
    return col;
  });
  dash.replaceChildren(...cols);
  tickDurations();
}

function select(project) {
  selected = project;
  for (const a of dash.querySelectorAll('.card')) {
    const on = a.dataset.project === project;
    a.classList.toggle('selected', on);
    if (on) a.scrollIntoView({ block: 'nearest' });
  }
}

function openProject(project) {
  location.hash = `#/s/${encodeURIComponent(project)}`;
}

// ---------- Notifications (needs_you uniquement) ----------

function updateNotifButton() {
  notifBtn.hidden = !('Notification' in window) || Notification.permission !== 'default' || current !== null;
}
notifBtn.onclick = async () => {
  try { await Notification.requestPermission(); } catch { /* ignoré */ }
  updateNotifButton();
};

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    setTimeout(() => ctx.close(), 500);
  } catch { /* son indisponible */ }
}

function alertNeedsYou(card) {
  if (current === card.project && document.hasFocus()) return; // déjà sous les yeux
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`${card.project} attend ta réponse`, { body: card.activity || 'Permission demandée' });
      n.onclick = () => { window.focus(); openProject(card.project); n.close(); };
    } catch { /* ignoré */ }
  }
}

function onSessions(list) {
  const before = new Map(cards.map((c) => [c.project, c.state]));
  cards = list;
  if (seeded) {
    for (const c of cards) if (c.state === 'needs_you' && before.get(c.project) !== 'needs_you') alertNeedsYou(c);
  }
  seeded = true;
  document.title = titleFor(titleCount(cards));
  if (current === null) renderDash();
}

// ---------- Sélecteur de reprise ----------

let started = false; // une session vit-elle déjà pour le projet affiché ?

function resetSessionView() {
  term.reset();
  nterm.reset();
  conv.replaceChildren();
  msgEls = new Map();
  pendingEl = null;
  showStatusLine('');
  toolEls = new Map();
  nfit.fit();
}

function closePicker() {
  picker.hidden = true;
  conv.hidden = false;
  nterm.focus();
}

function openPicker() {
  conv.hidden = true;
  picker.hidden = false;
  picker.replaceChildren(el('p', 'empty', 'Chargement des sessions…'));
  send({ type: 'list-sessions', project: current });
}

function renderPicker(list) {
  const nodes = [el('h2', null, started ? 'Reprendre une session' : 'Choisir une session')];
  if (started) {
    const cancel = el('button', 'opt', 'Annuler');
    cancel.onclick = closePicker;
    nodes.push(cancel);
  } else {
    const fresh = el('button', 'opt new', 'Nouvelle session');
    fresh.onclick = () => startNew();
    nodes.push(fresh);
  }
  if (!list.length) nodes.push(el('p', 'empty', 'Aucune session passée pour ce projet.'));
  const now = Date.now();
  for (const s of list) {
    const b = el('button', 'opt');
    b.append(el('span', 't', s.title), el('span', 'ago', formatAgo(s.mtime, now)));
    b.onclick = () => resumeSession(s.id);
    nodes.push(b);
  }
  picker.replaceChildren(...nodes);
  const first = picker.querySelector('button');
  if (first) first.focus();
}

function startNew() {
  started = true;
  resumeBtn.hidden = false;
  closePicker();
  nfit.fit();
  send({ type: 'start', project: current, cols: term.cols, rows: term.rows });
  send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
}

function resumeSession(id) {
  const st = stateEl.dataset.state;
  if (started && (st === 'running' || st === 'needs_you')
      && !confirm('La session en cours sera arrêtée (le tour en cours est perdu). Reprendre quand même ?')) return;
  resetSessionView();
  started = true;
  resumeBtn.hidden = false;
  closePicker();
  send({ type: 'resume', project: current, id, cols: term.cols, rows: term.rows });
  send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
}

resumeBtn.onclick = () => openPicker();

// ---------- Vues et routage ----------

function showDash() {
  if (current !== null) { send({ type: 'detach' }); current = null; }
  sess.hidden = true;
  dash.hidden = false;
  backLink.hidden = true;
  toggle.hidden = true;
  interruptBtn.hidden = true;
  resumeBtn.hidden = true;
  stateEl.hidden = true;
  projName.textContent = '';
  started = false;
  setDrawer(false);
  updateNotifButton();
  renderDash();
}

function showSession(project) {
  if (current === project) return;
  if (current !== null) send({ type: 'detach' });
  current = project;
  dash.hidden = true;
  sess.hidden = false;
  backLink.hidden = false;
  toggle.hidden = false;
  interruptBtn.hidden = false;
  stateEl.hidden = false;
  stateEl.dataset.state = '';
  stateEl.textContent = '';
  projName.textContent = project;
  updateNotifButton();
  resetSessionView();
  const card = cards.find((c) => c.project === project);
  started = !!card && card.state !== 'stopped' && card.state !== 'error';
  resumeBtn.hidden = !started;
  if (started) {
    picker.hidden = true;
    conv.hidden = false;
    send({ type: 'start', project, cols: term.cols, rows: term.rows });
    send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
    nterm.focus();
  } else {
    openPicker(); // rien ne démarre avant le choix
  }
}

function route() {
  const m = /^#\/s\/(.+)$/.exec(location.hash);
  let project = null;
  if (m) {
    try { project = decodeURIComponent(m[1]); } catch { project = null; }
  }
  if (project && cards.some((c) => c.project === project)) showSession(project);
  else showDash();
}
window.addEventListener('hashchange', route);

// ---------- Clavier (tableau de bord seulement) ----------

let gPending = false;
document.addEventListener('keydown', (ev) => {
  if (current !== null || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const order = displayOrder().map((c) => c.project);
  if (!order.length) return;
  const i = order.indexOf(selected);
  if (gPending) {
    gPending = false;
    if (ev.key === 'n') {
      const p = nextWaiting(cards, selected);
      if (p) { select(p); openProject(p); }
      ev.preventDefault();
      return;
    }
  }
  if (ev.key === 'j') select(order[Math.min(order.length - 1, i + 1)]);
  else if (ev.key === 'k') select(order[Math.max(0, i - 1)]);
  else if (ev.key === 'Enter' && selected && ev.target === document.body) openProject(selected);
  else if (ev.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1000); }
});

// ---------- Connexion ----------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    status.textContent = 'connecté';
    route();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'sessions') { onSessions(msg.sessions); if (current === null && location.hash.startsWith('#/s/')) route(); }
    else if (current === null) return; // messages de session : seulement dans la vue session
    else if (msg.type === 'past-sessions') { if (msg.project === current && !picker.hidden) renderPicker(msg.sessions); }
    else if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'nvim-data') nterm.write(msg.data);
    else if (msg.type === 'nvim-exit') status.textContent = `nvim terminé (code ${msg.code})`;
    else if (msg.type === 'transcript') addItems(msg.items);
    else if (msg.type === 'pending') showPending(msg.text);
    else if (msg.type === 'status') showStatusLine(msg.text);
    else if (msg.type === 'transcript-reset') { conv.replaceChildren(); msgEls = new Map(); toolEls = new Map(); pendingEl = null; }
    else if (msg.type === 'state') showState(msg);
    else if (msg.type === 'exit') status.textContent = `claude terminé (code ${msg.code})`;
    else if (msg.type === 'error') status.textContent = `erreur : ${msg.message}`;
  };
  ws.onclose = () => { status.textContent = 'déconnecté'; };
}

term.onData((data) => send({ type: 'input', data }));
nterm.onData((data) => send({ type: 'nvim-input', data }));
nterm.onResize(({ cols, rows }) => send({ type: 'nvim-resize', cols, rows }));
new ResizeObserver(() => { if (!sess.hidden) nfit.fit(); }).observe(document.getElementById('nvim'));
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
new ResizeObserver(() => { if (drawer.classList.contains('open')) fit.fit(); }).observe(document.getElementById('drawer'));

connect();
