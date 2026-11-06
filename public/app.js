import { renderMarkdown, toolTarget } from '/render.js';
import { ansiSegments } from '/ansi.js';
import {
  COLUMNS, groupByColumn, formatDuration, titleCount, titleFor, nextWaiting, formatAgo, turnLine, writersIn, sessionName,
  pastSessionAction, parseRoute, cardHref, placeTitle,
} from '/dashboard.js';

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
const addBtn = document.getElementById('add-btn');
const closeBtn = document.getElementById('close-btn');
const tabsEl = document.getElementById('tabs');

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

// Neovim sous la conversation (défaut) ou à droite ; choix retenu par ce navigateur seulement.
const layoutBtn = document.getElementById('layout');
function setLayout(right) {
  document.body.classList.toggle('nvim-right', right);
  layoutBtn.textContent = right ? 'Neovim en bas' : 'Neovim à droite';
  try { localStorage.setItem('nvim-layout', right ? 'right' : 'bottom'); } catch { /* stockage indisponible */ }
}
let savedLayout = null;
try { savedLayout = localStorage.getItem('nvim-layout'); } catch { /* stockage indisponible */ }
setLayout(savedLayout === 'right');
layoutBtn.onclick = () => { setLayout(!document.body.classList.contains('nvim-right')); nterm.focus(); };

let ws = null;
let msgEls = new Map();   // msgId -> élément .body
let toolEls = new Map();  // toolUseId -> <details>
let cards = [];           // dernier flux global reçu
let seeded = false;       // la première liste reçue ne déclenche aucune notification
let current = null;       // projet affiché dans la vue session (null = tableau de bord)
let currentChantier = null; // chantier affiché (null = dossier principal du projet)
let awaitPlace = null;    // chantier tout juste créé : on l'ouvre dès qu'il apparaît dans le flux global
let chantierMsgEl = null; // ligne du sélecteur où s'affiche le refus de création ou de clôture
let currentId = null;     // id de la session affichée (null : choix d'une nouvelle session ou reprise)
let selected = null;      // key de la carte sélectionnée au clavier
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
  if (item.kind === 'turn') {
    // La vraie fin de tour (JSONL) remplace la ligne provisoire calculée au Stop.
    if (liveEl && !turnStart) { liveEl.remove(); liveEl = null; }
    const end = item.ts ? new Date(item.ts) : null;
    conv.append(el('div', 'turn', turnLine({ running: false, elapsedMs: item.durationMs, endedAt: end })));
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
  if (liveEl && turnStart) conv.append(liveEl); // la ligne « En cours… » reste sous la réponse
  if (stick) conv.scrollTop = conv.scrollHeight;
}

// ---------- Ligne d'activité sous la réponse (« ✻ En cours… 12 s · outil ») ----------

let liveEl = null;     // ligne en cours, ou provisoire après le Stop en attendant turn_duration
let turnStart = null;  // début du tour en cours (ms), null hors tour
let liveActivity = '';
let lastState = null;

function renderLive() {
  if (!liveEl || !turnStart) return;
  liveEl.textContent = turnLine({ running: true, elapsedMs: Date.now() - turnStart, activity: liveActivity });
}
setInterval(renderLive, 1000);

function updateLive(msg) {
  const busy = msg.state === 'running' || msg.state === 'needs_you';
  const wasBusy = lastState === 'running' || lastState === 'needs_you';
  const first = lastState === null;
  lastState = msg.state;
  if (busy) {
    // Page ouverte en plein tour : `since` (début de l'état) est la meilleure estimation.
    if (!turnStart) turnStart = first ? (msg.since ?? Date.now()) : Date.now();
    liveActivity = msg.activity || '';
    if (!liveEl) liveEl = el('div', 'turn live');
    const stick = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
    conv.append(liveEl);
    renderLive();
    if (stick) conv.scrollTop = conv.scrollHeight;
  } else if (wasBusy && turnStart && liveEl) {
    // Fin de tour : ligne provisoire, remplacée par turn_duration s'il arrive du JSONL.
    liveEl.classList.remove('live');
    liveEl.textContent = turnLine({ running: false, elapsedMs: Date.now() - turnStart, endedAt: new Date() });
    turnStart = null;
  } else if (liveEl && turnStart) {
    liveEl.remove(); liveEl = null; turnStart = null;
  }
}

function resetLive() {
  liveEl = null; turnStart = null; liveActivity = ''; lastState = null;
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
  updateLive(msg);
  if (msg.state === 'needs_you') setDrawer(true);
  if (msg.state === 'done_unread' && document.hasFocus()) send({ type: 'read' });
}
window.addEventListener('focus', () => {
  if (currentId && stateEl.dataset.state === 'done_unread') send({ type: 'read' });
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

/** Carte du lieu affiché (même projet, même chantier). */
const inCurrentPlace = (c) => c.project === current && (c.chantier ?? null) === currentChantier;
const currentPlace = () => ({ id: null, project: current, chantier: currentChantier });

function openCard(c) { location.hash = cardHref(c); }
function openKey(key) {
  const c = cards.find((x) => x.key === key);
  if (c) openCard(c);
}

function tagFor(c) {
  const name = sessionName(c);
  return name ? el('span', `tag ${c.mode ?? ''}`, name) : null;
}

function makeCard(c) {
  const a = el('article', `card${c.key === selected ? ' selected' : ''}`);
  a.dataset.state = c.state;
  a.dataset.key = c.key;
  a.tabIndex = 0;
  const head = el('div', 'head');
  const dur = el('span', 'dur');
  head.append(el('span', 'proj', placeTitle(c)));
  const tag = tagFor(c);
  if (tag) head.append(tag);
  head.append(el('span', 'branch', c.branch ?? ''), dur);
  durEls.push({ el: dur, since: c.state === 'stopped' ? null : c.since });
  a.append(head, el('div', 'label', STATE_LABELS[c.state] ?? c.state));
  if (c.activity) a.append(el('div', 'act', c.activity));
  if (c.excerpt) a.append(el('div', 'exc', c.excerpt));
  a.onclick = () => openCard(c);
  a.onkeydown = (ev) => { if (ev.key === 'Enter') openCard(c); };
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

function select(key) {
  selected = key;
  for (const a of dash.querySelectorAll('.card')) {
    const on = a.dataset.key === key;
    a.classList.toggle('selected', on);
    if (on) a.scrollIntoView({ block: 'nearest' });
  }
}

/** Onglets des sessions sœurs (même lieu : dossier principal ou chantier) dans la vue session. */
function renderTabs() {
  const sibs = current === null ? [] : cards.filter((c) => inCurrentPlace(c) && c.id);
  tabsEl.hidden = sibs.length === 0 || (sibs.length === 1 && sibs[0].id === currentId);
  tabsEl.replaceChildren(...sibs.map((c, i) => {
    const a = el('a', c.id === currentId ? 'on' : null);
    a.href = cardHref(c);
    a.dataset.state = c.state;
    a.title = STATE_LABELS[c.state] ?? c.state;
    a.append(tagFor(c) ?? el('span', 'tag', `session ${i + 1}`));
    return a;
  }));
}

function updateSessionButtons() {
  resumeBtn.hidden = !currentId;
  closeBtn.hidden = !currentId;
  addBtn.hidden = current === null;
  renderTabs();
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
  if (currentId === card.id && document.hasFocus()) return; // déjà sous les yeux
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const name = sessionName(card);
      const n = new Notification(`${placeTitle(card)}${name ? ` · ${name}` : ''} attend ta réponse`, { body: card.activity || 'Permission demandée' });
      n.onclick = () => { window.focus(); openCard(card); n.close(); };
    } catch { /* ignoré */ }
  }
}

/** Chantier tout juste créé : ouvert dès que le flux global le connaît (l'ordre des deux messages n'est pas garanti). */
function openAwaitedPlace() {
  if (!awaitPlace || !cards.some((c) => c.project === awaitPlace.project && c.chantier === awaitPlace.chantier)) return;
  const href = cardHref({ id: null, ...awaitPlace });
  awaitPlace = null;
  location.hash = href;
}

function onSessions(list) {
  const before = new Map(cards.map((c) => [c.key, c.state]));
  cards = list;
  if (seeded) {
    for (const c of cards) if (c.state === 'needs_you' && before.get(c.key) !== 'needs_you') alertNeedsYou(c);
  }
  seeded = true;
  document.title = titleFor(titleCount(cards));
  openAwaitedPlace();
  if (current === null) { renderDash(); return; }
  // Session affichée fermée ailleurs (autre onglet du navigateur) : retour au tableau de bord.
  if (currentId && !cards.some((c) => c.id === currentId)) { location.hash = '#/'; return; }
  renderTabs();
}

// ---------- Sélecteur : nouvelle session ou reprise ----------

let pickerMode = 'new'; // 'new' : nouvelle session dans le dossier ; 'replace' : « Reprendre… » remplace la session affichée
let pickerBack = null;  // session à rouvrir si on annule « + Session »

function resetSessionView() {
  term.reset();
  nterm.reset();
  conv.replaceChildren();
  msgEls = new Map();
  pendingEl = null;
  resetLive();
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
  send({ type: 'list-sessions', project: current, chantier: currentChantier });
}

/** Mode et étiquette choisis dans le formulaire du sélecteur. */
function pickerChoice() {
  const mode = picker.querySelector('input[name="mode"]:checked')?.value ?? 'write';
  const label = picker.querySelector('input[name="label"]')?.value.trim() ?? '';
  return { mode, label: label || undefined };
}

function newForm() {
  const form = el('div', 'form');
  const radio = (value, text, checked) => {
    const l = el('label');
    const r = el('input');
    r.type = 'radio'; r.name = 'mode'; r.value = value; r.checked = checked;
    l.append(r, ` ${text}`);
    return l;
  };
  const label = el('input');
  label.type = 'text'; label.name = 'label'; label.maxLength = 24; label.placeholder = 'étiquette (facultatif)';
  form.append(radio('write', 'Écrivain', true), radio('consult', 'Consultation (lecture seule)', false), label);
  const writers = writersIn(cards, current, currentChantier);
  const warn = el('p', 'warn', `${writers} écrivain${writers > 1 ? 's' : ''} déjà dans ce dossier : chacun ne committe que ses fichiers.`);
  warn.hidden = writers === 0;
  form.onchange = () => { warn.hidden = writers === 0 || pickerChoice().mode !== 'write'; };
  return [form, warn];
}

/** Dossier principal : créer un chantier (branche + worktree) depuis la branche courante. */
function chantierCreateForm() {
  const box = el('div', 'form chantier');
  const base = cards.find((c) => c.project === current && (c.chantier ?? null) === null)?.branch ?? '?';
  const name = el('input');
  name.type = 'text'; name.name = 'chantier'; name.maxLength = 40; name.placeholder = 'nom-du-chantier';
  name.pattern = '[a-z0-9]+(-[a-z0-9]+)*';
  const go = el('button', 'opt', 'Créer le chantier');
  const create = () => {
    const v = name.value.trim();
    if (!v) return;
    chantierMsgEl.textContent = 'Création du worktree…';
    chantierMsgEl.hidden = false;
    send({ type: 'create-chantier', project: current, name: v });
  };
  go.onclick = create;
  name.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); create(); } };
  box.append(el('h3', null, `Nouveau chantier (depuis ${base})`), name, go);
  const nodes = [box];
  if (base !== 'main' && base !== 'master') {
    nodes.push(el('p', 'warn', `Le dossier principal est sur « ${base} », pas sur main : le chantier partira de cette branche.`));
  }
  chantierMsgEl = el('p', 'warn');
  chantierMsgEl.hidden = true;
  nodes.push(chantierMsgEl);
  return nodes;
}

/** Chantier : le clore (refusé par le serveur si session vivante, fichiers modifiés ou branche non fusionnée). */
function chantierCloseForm() {
  const b = el('button', 'opt danger', 'Clore le chantier');
  b.onclick = () => {
    if (!confirm(`Clore le chantier « ${currentChantier} » ? Le worktree et la branche seront supprimés `
      + '(refusé s\'il reste une session, des fichiers modifiés ou une branche non fusionnée).')) return;
    chantierMsgEl.textContent = 'Clôture…';
    chantierMsgEl.hidden = false;
    send({ type: 'remove-chantier', project: current, chantier: currentChantier });
  };
  chantierMsgEl = el('p', 'warn');
  chantierMsgEl.hidden = true;
  return [b, chantierMsgEl];
}

function renderPicker(list) {
  const replace = pickerMode === 'replace';
  chantierMsgEl = null;
  const nodes = [el('h2', null, replace ? 'Reprendre une session' : `Nouvelle session dans ${placeTitle(currentPlace())}`)];
  if (replace || pickerBack) {
    const cancel = el('button', 'opt', 'Annuler');
    cancel.onclick = () => {
      if (replace) closePicker();
      else location.hash = `#/s/${encodeURIComponent(pickerBack)}`;
    };
    nodes.push(cancel);
  }
  if (!replace) {
    nodes.push(...newForm());
    const fresh = el('button', 'opt new', 'Nouvelle session');
    fresh.onclick = () => startNew();
    nodes.push(fresh);
    nodes.push(...(currentChantier === null ? chantierCreateForm() : chantierCloseForm()));
    nodes.push(el('h3', null, 'Reprendre une session passée'));
  }
  if (!list.length) nodes.push(el('p', 'empty', 'Aucune session passée pour ce projet.'));
  const now = Date.now();
  for (const s of list) {
    const b = el('button', 'opt');
    b.append(el('span', 't', s.title));
    if (s.open) b.append(el('span', 'open-tag', s.open === currentId ? 'affichée' : 'ouverte'));
    b.append(el('span', 'ago', formatAgo(s.mtime, now)));
    b.onclick = () => {
      const act = pastSessionAction(s, currentId);
      if (act === 'stay') closePicker();
      else if (act === 'goto') location.hash = `#/s/${encodeURIComponent(s.open)}`;
      else resumeSession(s.id);
    };
    nodes.push(b);
  }
  picker.replaceChildren(...nodes);
  const first = picker.querySelector('button');
  if (first) first.focus();
}

function startNew() {
  const { mode, label } = pickerChoice();
  resetSessionView();
  closePicker();
  send({ type: 'start', project: current, chantier: currentChantier, mode, label, cols: term.cols, rows: term.rows });
  send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
}

function resumeSession(id) {
  const msg = { type: 'resume', project: current, chantier: currentChantier, id, cols: term.cols, rows: term.rows };
  if (pickerMode === 'replace') {
    const st = stateEl.dataset.state;
    if ((st === 'running' || st === 'needs_you')
        && !confirm('La session affichée sera arrêtée (le tour en cours est perdu). Reprendre quand même ?')) return;
    msg.replace = currentId;
    currentId = null; // la session remplacée disparaît de la liste : ce n'est pas une fermeture venue d'ailleurs
  } else {
    Object.assign(msg, pickerChoice());
  }
  resetSessionView();
  closePicker();
  send(msg);
  send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
}

/** Réponse du serveur à start / resume : la session affichée a désormais cet id. */
function onStarted(id) {
  currentId = id;
  pickerBack = null;
  history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`);
  updateSessionButtons();
}

resumeBtn.onclick = () => { pickerMode = 'replace'; openPicker(); };
addBtn.onclick = () => {
  pickerBack = currentId;
  location.hash = cardHref(currentPlace());
};
closeBtn.onclick = () => {
  if (!currentId) return;
  if (!confirm('Arrêter claude et Neovim de cette session ? (le transcript reste, la session pourra être reprise)')) return;
  const id = currentId;
  send({ type: 'close', id });
  currentId = null;
  location.hash = '#/';
};

// ---------- Vues et routage ----------

function showDash() {
  if (current !== null) { send({ type: 'detach' }); current = null; }
  currentChantier = null;
  currentId = null;
  pickerBack = null;
  sess.hidden = true;
  dash.hidden = false;
  backLink.hidden = true;
  toggle.hidden = true;
  layoutBtn.hidden = true;
  interruptBtn.hidden = true;
  stateEl.hidden = true;
  projName.textContent = '';
  updateSessionButtons();
  setDrawer(false);
  updateNotifButton();
  renderDash();
}

function enterSessionView(project, chantier) {
  if (current !== null) send({ type: 'detach' });
  current = project;
  currentChantier = chantier ?? null;
  dash.hidden = true;
  sess.hidden = false;
  backLink.hidden = false;
  toggle.hidden = false;
  layoutBtn.hidden = false;
  interruptBtn.hidden = false;
  stateEl.hidden = false;
  stateEl.dataset.state = '';
  stateEl.textContent = '';
  projName.textContent = placeTitle({ project, chantier: currentChantier });
  updateNotifButton();
  resetSessionView();
}

/** Vue d'une session vivante (ou sortie, tant qu'elle n'est pas fermée). */
function showSession(card) {
  if (currentId === card.id) return;
  enterSessionView(card.project, card.chantier);
  currentId = card.id;
  pickerBack = null;
  picker.hidden = true;
  conv.hidden = false;
  send({ type: 'attach', id: card.id });
  send({ type: 'resize', cols: term.cols, rows: term.rows });
  send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
  updateSessionButtons();
  nterm.focus();
}

/** Lieu (dossier principal ou chantier) sans session affichée : rien ne démarre avant le choix. */
function showPlace(project, chantier) {
  enterSessionView(project, chantier);
  currentId = null;
  pickerMode = 'new';
  updateSessionButtons();
  openPicker();
}

function route() {
  const r = parseRoute(location.hash);
  const card = r.view === 'session' ? cards.find((c) => c.id === r.id) : null;
  if (card) showSession(card);
  else if (r.view === 'place' && cards.some((c) => c.project === r.project && (c.chantier ?? null) === r.chantier)) {
    showPlace(r.project, r.chantier);
  } else showDash();
}
window.addEventListener('hashchange', route);

// ---------- Clavier (tableau de bord seulement) ----------

let gPending = false;
document.addEventListener('keydown', (ev) => {
  if (current !== null || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const order = displayOrder().map((c) => c.key);
  if (!order.length) return;
  const i = order.indexOf(selected);
  if (gPending) {
    gPending = false;
    if (ev.key === 'n') {
      const k = nextWaiting(cards, selected);
      if (k) { select(k); openKey(k); }
      ev.preventDefault();
      return;
    }
  }
  if (ev.key === 'j') select(order[Math.min(order.length - 1, i + 1)]);
  else if (ev.key === 'k') select(order[Math.max(0, i - 1)]);
  else if (ev.key === 'Enter' && selected && ev.target === document.body) openKey(selected);
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
    if (msg.type === 'sessions') { onSessions(msg.sessions); if (current === null && /^#\/[sp]\//.test(location.hash)) route(); }
    else if (msg.type === 'chantier-created') { awaitPlace = { project: msg.project, chantier: msg.chantier }; openAwaitedPlace(); }
    else if (msg.type === 'chantier-removed') { if (msg.project === current && msg.chantier === currentChantier) location.hash = '#/'; }
    else if (current === null) return; // messages de session : seulement dans la vue session
    else if (msg.type === 'started') onStarted(msg.id);
    else if (msg.type === 'past-sessions') {
      if (msg.project === current && (msg.chantier ?? null) === currentChantier && !picker.hidden) renderPicker(msg.sessions);
    }
    else if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'nvim-data') nterm.write(msg.data);
    else if (msg.type === 'nvim-exit') status.textContent = `nvim terminé (code ${msg.code})`;
    else if (msg.type === 'transcript') addItems(msg.items);
    else if (msg.type === 'pending') showPending(msg.text);
    else if (msg.type === 'status') showStatusLine(msg.text);
    else if (msg.type === 'transcript-reset') { conv.replaceChildren(); msgEls = new Map(); toolEls = new Map(); pendingEl = null; resetLive(); }
    else if (msg.type === 'state') showState(msg);
    else if (msg.type === 'exit') status.textContent = `claude terminé (code ${msg.code})`;
    else if (msg.type === 'error') {
      status.textContent = `erreur : ${msg.message}`;
      if (chantierMsgEl?.isConnected && !chantierMsgEl.hidden) chantierMsgEl.textContent = `Refusé : ${msg.message}`;
      if (currentId === null && picker.hidden) openPicker(); // démarrage refusé (étiquette invalide…) : retour au choix
    }
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
