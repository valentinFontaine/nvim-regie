const select = document.getElementById('project');
const launch = document.getElementById('launch');
const status = document.getElementById('status');

const term = new window.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000 });
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();

let ws = null;

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(project) {
  if (ws) ws.close();
  term.reset();
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    status.textContent = 'connecté';
    send({ type: 'start', project, cols: term.cols, rows: term.rows });
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(msg.data);
    else if (msg.type === 'exit') status.textContent = `claude terminé (code ${msg.code})`;
    else if (msg.type === 'error') status.textContent = `erreur : ${msg.message}`;
  };
  ws.onclose = () => { status.textContent = 'déconnecté'; };
}

term.onData((data) => send({ type: 'input', data }));
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term'));
launch.onclick = () => connect(select.value);

const projects = await (await fetch('/api/projects')).json();
for (const p of projects) {
  const o = document.createElement('option');
  o.value = o.textContent = p.name;
  select.append(o);
}
