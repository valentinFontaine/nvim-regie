import { renderMarkdown, toolTarget } from '/render.js';

const select = document.getElementById('project');
const launch = document.getElementById('launch');
const status = document.getElementById('status');
const conv = document.getElementById('conv');
const drawer = document.getElementById('drawer');
const toggle = document.getElementById('toggle-term');

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

function addItems(items) {
  const stick = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
  for (const it of items) addItem(it);
  if (stick) conv.scrollTop = conv.scrollHeight;
}

function connect(project) {
  if (ws) ws.close();
  term.reset();
  nterm.reset();
  conv.replaceChildren();
  msgEls = new Map();
  toolEls = new Map();
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    status.textContent = 'connecté';
    nfit.fit();
    send({ type: 'start', project, cols: term.cols, rows: term.rows });
    send({ type: 'nvim-resize', cols: nterm.cols, rows: nterm.rows });
    nterm.focus();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'nvim-data') nterm.write(msg.data);
    else if (msg.type === 'nvim-exit') status.textContent = `nvim terminé (code ${msg.code})`;
    else if (msg.type === 'transcript') addItems(msg.items);
    else if (msg.type === 'exit') status.textContent = `claude terminé (code ${msg.code})`;
    else if (msg.type === 'error') status.textContent = `erreur : ${msg.message}`;
  };
  ws.onclose = () => { status.textContent = 'déconnecté'; };
}

term.onData((data) => send({ type: 'input', data }));
nterm.onData((data) => send({ type: 'nvim-input', data }));
nterm.onResize(({ cols, rows }) => send({ type: 'nvim-resize', cols, rows }));
new ResizeObserver(() => nfit.fit()).observe(document.getElementById('nvim'));
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
new ResizeObserver(() => { if (drawer.classList.contains('open')) fit.fit(); }).observe(document.getElementById('drawer'));
launch.onclick = () => {
  connect(select.value); // la saisie se fait dans Neovim ; le tiroir sert aux commandes slash et permissions
};

const projects = await (await fetch('/api/projects')).json();
for (const p of projects) {
  const o = document.createElement('option');
  o.value = o.textContent = p.name;
  select.append(o);
}
