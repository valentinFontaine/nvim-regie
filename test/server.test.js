import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session.js';

const PORT = 47655;
const token = 'a'.repeat(64);
let app;
let sessions;

before(async () => {
  sessions = new SessionManager({
    command: process.execPath,
    args: () => ['-e', "process.stdout.write('READY\\n');setInterval(()=>{},1000)"],
  });
  app = createApp({
    config: { port: PORT, projects: [{ name: 'demo', path: process.cwd() }] },
    token,
    sessions,
    pastSessions: (project) => (project.name === 'demo' ? [{ id: '55555555-5555-4555-8555-555555555555', title: 'Titre passé', mtime: 1, size: 2 }] : []),
  });
  await app.listen();
});
after(async () => { await app.close(); });

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${PORT}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
async function cookie() {
  const r = await get(`/?token=${token}`);
  return r.headers['set-cookie'][0].split(';')[0];
}

test('écoute sur 127.0.0.1 uniquement', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
});

test('401 sans cookie, y compris statiques et API', async () => {
  for (const p of ['/', '/app.js', '/api/projects', '/vendor/xterm/lib/xterm.js']) {
    assert.equal((await get(p)).status, 401, p);
  }
});

test('mauvais jeton : 401, pas de cookie', async () => {
  const r = await get(`/?token=${'b'.repeat(64)}`);
  assert.equal(r.status, 401);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('Host étranger refusé (DNS rebinding)', async () => {
  const r = await get(`/?token=${token}`, { host: 'evil.example' });
  assert.equal(r.status, 403);
});

test('jeton valide : cookie HttpOnly SameSite=Strict + 302 vers /', async () => {
  const r = await get(`/?token=${token}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  const c = r.headers['set-cookie'][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
});

test('avec cookie : page, app, vendor, API', async () => {
  const c = await cookie();
  assert.equal((await get('/', { cookie: c })).status, 200);
  assert.equal((await get('/app.js', { cookie: c })).status, 200);
  assert.equal((await get('/vendor/xterm/lib/xterm.js', { cookie: c })).status, 200);
  assert.equal((await get('/vendor/xterm/css/xterm.css', { cookie: c })).status, 200);
  assert.equal((await get('/vendor/addon-fit/lib/addon-fit.js', { cookie: c })).status, 200);
  for (const p of [
    '/vendor/marked/marked.esm.js',
    '/vendor/dompurify/purify.es.mjs',
    '/vendor/highlight/core.js',
    '/vendor/highlight/languages/javascript.js',
    '/vendor/highlight/styles/github-dark.min.css',
    '/render.js',
    '/dashboard.js',
  ]) {
    assert.equal((await get(p, { cookie: c })).status, 200, p);
    assert.equal((await get(p)).status, 401, p);
  }
  const api = await get('/api/projects', { cookie: c });
  assert.deepEqual(JSON.parse(api.body), [{ name: 'demo' }]);
});

test('traversée de chemin et fichiers hors liste refusés', async () => {
  const c = await cookie();
  const paths = [
    '/vendor/xterm/../../../package.json',
    '/vendor/xterm/%2e%2e/%2e%2e/package.json',
    '/vendor/xterm/package.json',
    '/package.json',
    '/../package.json',
    '/src/server.js',
    '/vendor/highlight/languages/../../package.json',
    '/vendor/highlight/languages/%2e%2e/package.json',
    '/vendor/highlight/languages/..%5c..%5cpackage.json',
    '/vendor/highlight/languages/README.md',
    '/vendor/marked/package.json',
  ];
  for (const p of paths) {
    const r = await get(p, { cookie: c });
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

function openWs(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('error', () => resolve({ ok: false }));
    ws.on('unexpected-response', () => resolve({ ok: false }));
  });
}

test('WS refusé sans cookie, ou avec mauvais Origin', async () => {
  const c = await cookie();
  assert.equal((await openWs({ origin: `http://127.0.0.1:${PORT}` })).ok, false);
  assert.equal((await openWs({ cookie: c })).ok, false);
  assert.equal((await openWs({ cookie: c, origin: 'http://evil.example' })).ok, false);
});

test('WS : démarre un projet de la liste ; hors liste et non-JSON refusés', async () => {
  const c = await cookie();
  const { ok, ws } = await openWs({ cookie: c, origin: `http://127.0.0.1:${PORT}` });
  assert.equal(ok, true);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  ws.send(JSON.stringify({ type: 'start', project: '../../etc', cols: 80, rows: 24 }));
  ws.send('pas du json');
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  const t = Date.now();
  while (Date.now() - t < 8000 && !msgs.some((m) => m.type === 'data' && m.data.includes('READY'))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(msgs.some((m) => m.type === 'error'), 'projet hors liste -> error');
  assert.ok(msgs.some((m) => m.type === 'data' && m.data.includes('READY')));
  ws.close();
});

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve(413) : reject(e)));
    req.end(data);
  });
}

test("hooks : jeton dans l'URL, sans cookie, applique l'événement à la bonne session", async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  const url = (t, id) => `/hooks/${t}/${id}`;
  assert.equal(await post(url(token, s.id), { hook_event_name: 'UserPromptSubmit' }), 204);
  assert.equal(s.snap.state, 'running');
  assert.equal(await post(url('b'.repeat(64), s.id), { hook_event_name: 'Stop' }), 401);
  assert.equal(s.snap.state, 'running');
  assert.equal(await post(url(token, '00000000-0000-4000-8000-000000000000'), {}), 404);
  assert.equal(await post(url(token, 'pas-un-uuid'), {}), 404);
  assert.equal(await post(url(token, s.id), 'pas du json'), 400);
  assert.equal(await post(url(token, s.id), { hook_event_name: 'Stop', pad: 'x'.repeat(70_000) }), 413);
  assert.equal(await post(url(token, s.id), { hook_event_name: 'Stop' }, { host: 'evil.test' }), 403);
  assert.equal(s.snap.state, 'running');
  assert.equal((await get(url(token, s.id))).status, 405);
});

test('WS : message read fait passer done_unread à idle', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'done_unread');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: await cookie(), origin: `http://127.0.0.1:${PORT}` } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'read' }));
  const t = Date.now();
  while (s.snap.state !== 'idle' && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.snap.state, 'idle');
  ws.close();
});

test('WS : message interrupt accepté ; aucun effet sans session', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  let writes = 0;
  const orig = s.interrupt.bind(s);
  s.interrupt = () => { writes++; orig(); };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: await cookie(), origin: `http://127.0.0.1:${PORT}` } });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'interrupt' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(writes, 0);
  assert.equal(msgs.some((m) => m.type === 'error'), false);
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'interrupt' }));
  const t = Date.now();
  while (writes === 0 && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 30));
  assert.equal(writes, 1);
  ws.close();
});

async function openCollect() {
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: await cookie(), origin: `http://127.0.0.1:${PORT}` } });
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  return { ws, msgs };
}
async function waitFor(fn, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms && !fn()) await new Promise((r) => setTimeout(r, 30));
  assert.ok(fn(), 'délai dépassé');
}

test('WS : le flux global des sessions arrive dès la connexion (sans start) et suit les hooks', async () => {
  const { ws, msgs } = await openCollect();
  await waitFor(() => msgs.some((m) => m.type === 'sessions'));
  const first = msgs.find((m) => m.type === 'sessions');
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].project, 'demo');
  assert.ok(!msgs.some((m) => m.type === 'data' || m.type === 'state'), 'rien de la session sans start');
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions[0].state === 'needs_you'));
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  ws.close();
});

test('WS : detach arrête les messages de la session et neutralise read', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'done_unread');
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'state'));
  ws.send(JSON.stringify({ type: 'detach' }));
  ws.send(JSON.stringify({ type: 'read' }));
  ws.send(JSON.stringify({ type: 'interrupt' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.snap.state, 'done_unread');
  const n = msgs.filter((m) => m.type === 'state').length;
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions[0].state === 'running'));
  assert.equal(msgs.filter((m) => m.type === 'state').length, n, 'plus de message de session après detach');
  ws.close();
});

const PAST_ID = '55555555-5555-4555-8555-555555555555';

test('WS : list-sessions renvoie les sessions passées du projet (hors liste : erreur)', async () => {
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'list-sessions', project: '../x' }));
  ws.send(JSON.stringify({ type: 'list-sessions', project: 'demo' }));
  await waitFor(() => msgs.some((m) => m.type === 'past-sessions'));
  const r = msgs.find((m) => m.type === 'past-sessions');
  assert.equal(r.project, 'demo');
  assert.deepEqual(r.sessions, [{ id: PAST_ID, title: 'Titre passé', mtime: 1, size: 2 }]);
  assert.ok(msgs.some((m) => m.type === 'error'));
  ws.close();
});

test('WS : resume valide l\'id contre le listing du projet, remplace la session vivante et s\'y rattache', async () => {
  const old = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  const { ws, msgs } = await openCollect();
  for (const bad of ['../../x', '00000000-0000-4000-8000-000000000000', 42, undefined]) {
    ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: bad, cols: 80, rows: 24 }));
  }
  ws.send(JSON.stringify({ type: 'resume', project: 'inconnu', id: PAST_ID, cols: 80, rows: 24 }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 5);
  assert.equal(sessions.sessions.get('demo'), old, 'rien n\'est remplacé par une demande invalide');
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, cols: 80, rows: 24 }));
  await waitFor(() => sessions.sessions.get('demo') !== old);
  const fresh = sessions.sessions.get('demo');
  assert.equal(fresh.claudeId, PAST_ID);
  await waitFor(() => msgs.some((m) => m.type === 'data' && m.data.includes('READY')));
  ws.close();
});
