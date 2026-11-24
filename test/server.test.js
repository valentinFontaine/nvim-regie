import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session.js';

const PORT = 47655;
const token = 'a'.repeat(64);
let app;
let sessions;

// Chantiers simulés : le vrai git est testé dans chantiers.test.js (jamais de worktree dans ce dépôt).
const WT_PATH = process.cwd();
const fakeWt = new Map([['x', { name: 'x', path: WT_PATH, branch: 'x' }]]);
const chantierCalls = [];
// Ajout de dossier simulé : la vraie écriture de config.json est testée dans config.test.js.
const CANDIDATES = [
  { path: path.join(os.tmpdir(), 'cand-un'), name: 'cand-un' },
  { path: path.join(os.tmpdir(), 'cand-deux'), name: 'cand-deux' },
];
const candidatesCalls = [];
const saved = [];
const dropped = [];
let failSave = false;
const launched = []; // lanceurs factices : rien n'est jamais ouvert pendant les tests
const pastCalls = [];
const chantiers = {
  list: (p) => (p.name === 'demo' ? [...fakeWt.values()].sort((a, b) => a.name.localeCompare(b.name)) : []),
  create: async (p, name) => {
    chantierCalls.push(['create', p.name, name]);
    const c = { name, path: WT_PATH, branch: name };
    fakeWt.set(name, c);
    return c;
  },
  remove: async (p, name, { hasLiveSession } = {}) => {
    chantierCalls.push(['remove', p.name, name, hasLiveSession]);
    if (hasLiveSession) throw new Error('session vivante dans ce chantier');
    fakeWt.delete(name);
    return { leftover: `/reste/${name}` };
  },
};

before(async () => {
  sessions = new SessionManager({
    command: process.execPath,
    args: () => ['-e', "process.stdout.write('READY\\n');setInterval(()=>{},1000)"],
    listChantiers: chantiers.list,
  });
  app = createApp({
    config: { port: PORT, projects: [{ name: 'demo', path: process.cwd() }] },
    token,
    sessions,
    chantiers,
    candidates: (tracked) => {
      candidatesCalls.push(tracked.length);
      const have = new Set(tracked.map((p) => p.path));
      return CANDIDATES.filter((c) => !have.has(c.path));
    },
    saveProject: (p) => {
      if (failSave) throw new Error('disque plein');
      saved.push(p);
      return p;
    },
    dropProject: (name) => { dropped.push(name); },
    openWith: (abs) => { launched.push(['open', abs]); },
    reveal: (abs) => { launched.push(['reveal', abs]); },
    chantierNote: (p, branch) => (p.name === 'demo' && branch === 'x' ? '**Objectif** : o\n\ntexte' : null),
    pastSessions: (place) => {
      pastCalls.push(place);
      return place.name === 'demo' ? [{ id: '55555555-5555-4555-8555-555555555555', title: 'Titre passé', mtime: 1, size: 2 }] : [];
    },
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

test('/api/note : 401 sans cookie ; avec cookie, note du chantier ; 404 si inconnu ou sans note', async () => {
  const q = (p, c) => `/api/note?project=${encodeURIComponent(p)}&chantier=${encodeURIComponent(c)}`;
  assert.equal((await get(q('demo', 'x'))).status, 401);
  const c = await cookie();
  const ok = await get(q('demo', 'x'), { cookie: c });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(ok.body), { text: '**Objectif** : o\n\ntexte' });
  for (const [p, ch] of [['demo', 'inconnu'], ['autre', 'x'], ['demo', '../x'], ['demo', ''], ['', 'x']]) {
    assert.equal((await get(q(p, ch), { cookie: c })).status, 404, `${p}/${ch}`);
  }
  assert.equal((await get('/api/note', { cookie: c })).status, 404, 'sans paramètres');
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
  ws.send(JSON.stringify({ type: 'attach', id: s.id, cols: 80, rows: 24 }));
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
  ws.send(JSON.stringify({ type: 'attach', id: s.id, cols: 80, rows: 24 }));
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
  assert.ok(first.sessions.length >= 1);
  assert.ok(first.sessions.every((x) => x.project === 'demo'));
  assert.ok(!msgs.some((m) => m.type === 'data' || m.type === 'state'), 'rien de la session sans start');
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions.find((x) => x.key === s.id)?.state === 'needs_you'));
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  ws.close();
});

test('WS : detach arrête les messages de la session et neutralise read', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'done_unread');
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'attach', id: s.id, cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'state'));
  ws.send(JSON.stringify({ type: 'detach' }));
  ws.send(JSON.stringify({ type: 'read' }));
  ws.send(JSON.stringify({ type: 'interrupt' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.snap.state, 'done_unread');
  const n = msgs.filter((m) => m.type === 'state').length;
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions.find((x) => x.key === s.id)?.state === 'running'));
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
  assert.deepEqual(r.sessions, [{ id: PAST_ID, title: 'Titre passé', mtime: 1, size: 2, open: null }]);
  assert.ok(msgs.some((m) => m.type === 'error'));
  ws.close();
});

const closeAll = () => { for (const id of [...sessions.sessions.keys()]) sessions.close(id); };

test('WS : start crée une nouvelle session (mode, étiquette), répond started et s\'y abonne', async () => {
  closeAll();
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'start', project: 'demo', mode: 'write', label: 'code', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'start', project: 'demo', mode: 'consult', cols: 80, rows: 24 }));
  await waitFor(() => msgs.filter((m) => m.type === 'started').length === 2);
  const [a, b] = msgs.filter((m) => m.type === 'started').map((m) => sessions.get(m.id));
  assert.notEqual(a, b);
  assert.deepEqual([a.mode, a.label, b.mode, b.label], ['write', 'code', 'consult', '']);
  ws.send(JSON.stringify({ type: 'start', project: 'demo', mode: 'root', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'start', project: 'demo', label: '<script>', cols: 80, rows: 24 }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 2);
  assert.equal(sessions.sessions.size, 2, 'mode ou étiquette invalide : rien ne démarre');
  ws.close();
  closeAll();
});

test('WS : attach sur un id inconnu ou invalide → erreur', async () => {
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'attach', id: '00000000-0000-4000-8000-000000000000', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'attach', id: 42, cols: 80, rows: 24 }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 2);
  ws.close();
});

test('WS : resume valide l\'id contre le listing du projet, crée une session et s\'y rattache', async () => {
  closeAll();
  const { ws, msgs } = await openCollect();
  for (const bad of ['../../x', '00000000-0000-4000-8000-000000000000', 42, undefined]) {
    ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: bad, cols: 80, rows: 24 }));
  }
  ws.send(JSON.stringify({ type: 'resume', project: 'inconnu', id: PAST_ID, cols: 80, rows: 24 }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 5);
  assert.equal(sessions.sessions.size, 0, 'rien ne démarre sur une demande invalide');
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, mode: 'consult', label: 'relu', cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  const fresh = sessions.get(msgs.find((m) => m.type === 'started').id);
  assert.equal(fresh.claudeId, PAST_ID);
  assert.deepEqual([fresh.mode, fresh.label], ['consult', 'relu']);
  await waitFor(() => msgs.some((m) => m.type === 'data' && m.data.includes('READY')));
  ws.close();
});

test('WS : resume d\'une session déjà ouverte ne relance rien et renvoie son id', async () => {
  const open = sessions.byClaudeId(PAST_ID) ?? sessions.start({ name: 'demo', path: process.cwd() }, 80, 24, { resume: PAST_ID });
  const n = sessions.sessions.size;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  assert.equal(msgs.find((m) => m.type === 'started').id, open.id);
  assert.equal(sessions.sessions.size, n);
  ws.send(JSON.stringify({ type: 'list-sessions', project: 'demo' }));
  await waitFor(() => msgs.some((m) => m.type === 'past-sessions'));
  assert.equal(msgs.find((m) => m.type === 'past-sessions').sessions[0].open, open.id);
  ws.close();
  closeAll();
});

test('WS : resume avec replace ferme la session remplacée (même projet seulement)', async () => {
  closeAll();
  const old = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24, { label: 'vieux' });
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, replace: 'pas-un-id', cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  assert.equal(sessions.get(old.id), old);
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, replace: old.id, cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  assert.equal(sessions.get(old.id), null);
  await waitFor(() => old.exited);
  const fresh = sessions.get(msgs.find((m) => m.type === 'started').id);
  assert.equal(fresh.claudeId, PAST_ID);
  assert.equal(fresh.label, 'vieux', 'le remplacement garde mode et étiquette si non précisés');
  ws.close();
  closeAll();
});

test('WS : close ferme une session ; id inconnu → erreur', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'attach', id: s.id, cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'close', id: s.id }));
  await waitFor(() => sessions.get(s.id) === null);
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && !m.sessions.some((x) => x.key === s.id)));
  ws.send(JSON.stringify({ type: 'close', id: s.id }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  ws.close();
});

test('WS : start dans un chantier listé ; chantier inconnu ou invalide → erreur, rien ne démarre', async () => {
  closeAll();
  const { ws, msgs } = await openCollect();
  for (const bad of ['inconnu', '../x', 42]) {
    ws.send(JSON.stringify({ type: 'start', project: 'demo', chantier: bad, cols: 80, rows: 24 }));
  }
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 3);
  assert.equal(sessions.sessions.size, 0);
  ws.send(JSON.stringify({ type: 'start', project: 'demo', chantier: 'x', cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  const s = sessions.get(msgs.find((m) => m.type === 'started').id);
  assert.equal(s.chantier, 'x');
  assert.equal(s.project.path, WT_PATH);
  assert.equal(s.project.name, 'demo');
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions.find((c) => c.key === s.id)?.chantier === 'x'));
  ws.close();
  closeAll();
});

test('WS : list-sessions et resume dans un chantier passent le lieu du chantier', async () => {
  closeAll();
  pastCalls.length = 0;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'list-sessions', project: 'demo', chantier: 'x' }));
  await waitFor(() => msgs.some((m) => m.type === 'past-sessions'));
  const r = msgs.find((m) => m.type === 'past-sessions');
  assert.equal(r.chantier, 'x');
  assert.equal(pastCalls.at(-1).chantier, 'x');
  ws.send(JSON.stringify({ type: 'list-sessions', project: 'demo', chantier: 'inconnu' }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', chantier: 'x', id: PAST_ID, cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  assert.equal(sessions.get(msgs.find((m) => m.type === 'started').id).chantier, 'x');
  ws.close();
  closeAll();
});

test('WS : resume avec replace refusé si la session remplacée est dans un autre lieu', async () => {
  closeAll();
  const old = sessions.start({ name: 'demo', path: WT_PATH, chantier: 'x' }, 80, 24);
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'resume', project: 'demo', id: PAST_ID, replace: old.id, cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  assert.equal(sessions.get(old.id), old, 'la session du chantier n\'est pas remplacée depuis le dossier principal');
  assert.equal(msgs.some((m) => m.type === 'started'), false);
  ws.close();
  closeAll();
});

test('WS : create-chantier valide le nom, crée, répond et renotifie le flux global', async () => {
  chantierCalls.length = 0;
  const { ws, msgs } = await openCollect();
  for (const bad of ['../x', 'Main', 'main', 42]) ws.send(JSON.stringify({ type: 'create-chantier', project: 'demo', name: bad }));
  ws.send(JSON.stringify({ type: 'create-chantier', project: 'inconnu', name: 'ok' }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 5);
  assert.deepEqual(chantierCalls, [], 'nom ou projet invalide : create jamais appelé');
  ws.send(JSON.stringify({ type: 'create-chantier', project: 'demo', name: 'nouveau' }));
  await waitFor(() => msgs.some((m) => m.type === 'chantier-created'));
  assert.deepEqual(msgs.find((m) => m.type === 'chantier-created'), { type: 'chantier-created', project: 'demo', chantier: 'nouveau' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions.some((c) => c.key === 'c:demo/nouveau')));
  ws.close();
});

test('WS : remove-chantier refusé si session vivante, sinon retire et renotifie', async () => {
  closeAll();
  fakeWt.set('y', { name: 'y', path: WT_PATH, branch: 'y' });
  chantierCalls.length = 0;
  const s = sessions.start({ name: 'demo', path: WT_PATH, chantier: 'y' }, 80, 24);
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'remove-chantier', project: 'demo', chantier: 'y' }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  assert.match(msgs.find((m) => m.type === 'error').message, /session/);
  assert.deepEqual(chantierCalls.at(-1), ['remove', 'demo', 'y', true]);
  sessions.close(s.id);
  ws.send(JSON.stringify({ type: 'remove-chantier', project: 'demo', chantier: 'y' }));
  await waitFor(() => msgs.some((m) => m.type === 'chantier-removed'));
  assert.deepEqual(msgs.find((m) => m.type === 'chantier-removed'), { type: 'chantier-removed', project: 'demo', chantier: 'y', leftover: '/reste/y' });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && !m.sessions.some((c) => c.chantier === 'y')));
  ws.send(JSON.stringify({ type: 'remove-chantier', project: 'demo', chantier: 'inconnu' }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= 2);
  ws.close();
});

// Ajout de dossier : le client ne désigne qu'un chemin ; le serveur le retrouve dans SA liste de candidats.
test('WS : list-candidates renvoie la liste du serveur ; add-project refuse tout chemin hors de cette liste', async () => {
  candidatesCalls.length = 0;
  saved.length = 0;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'list-candidates' }));
  await waitFor(() => msgs.some((m) => m.type === 'candidates'));
  assert.deepEqual(msgs.find((m) => m.type === 'candidates').candidates, CANDIDATES);
  const bads = ['C:\\Windows', '..\\x', '', 42, null, { path: CANDIDATES[0].path }];
  for (const bad of bads) ws.send(JSON.stringify({ type: 'add-project', path: bad }));
  ws.send(JSON.stringify({ type: 'add-project' }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length >= bads.length + 1);
  assert.deepEqual(saved, [], 'rien écrit pour un chemin hors liste');
  assert.ok(!msgs.some((m) => m.type === 'project-added'));
  ws.close();
});

test('WS : add-project d\'un candidat → écrit dans la config, projet suivi à chaud, flux global renotifié', async () => {
  saved.length = 0;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'add-project', path: CANDIDATES[0].path }));
  await waitFor(() => msgs.some((m) => m.type === 'project-added'));
  assert.deepEqual(saved, [CANDIDATES[0]]);
  assert.deepEqual(msgs.find((m) => m.type === 'project-added'), { type: 'project-added', name: CANDIDATES[0].name });
  await waitFor(() => msgs.some((m) => m.type === 'sessions' && m.sessions.some((c) => c.project === CANDIDATES[0].name && c.state === 'stopped')));
  // Déjà suivi : n'est plus candidat, donc refusé (et jamais écrit deux fois).
  ws.send(JSON.stringify({ type: 'add-project', path: CANDIDATES[0].path }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  assert.equal(saved.length, 1);
  ws.close();
});

test('WS : add-project, erreur d\'écriture → message d\'erreur, projet non ajouté', async () => {
  failSave = true;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'add-project', path: CANDIDATES[1].path }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  assert.match(msgs.find((m) => m.type === 'error').message, /disque plein/);
  assert.ok(!msgs.some((m) => m.type === 'sessions' && m.sessions.some((c) => c.project === CANDIDATES[1].name)));
  failSave = false;
  ws.close();
});

// Retrait d'un dossier : refusé s'il reste une session vivante (dossier principal ou chantier) ou si c'est le dernier.
test('WS : remove-project refusé si session vivante, sinon retiré de la config et du flux ; jamais le dernier', async () => {
  closeAll();
  dropped.length = 0;
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'add-project', path: CANDIDATES[1].path }));
  await waitFor(() => msgs.some((m) => m.type === 'project-added' && m.name === 'cand-deux'));
  const errors = () => msgs.filter((m) => m.type === 'error').length;
  // Session vivante dans un chantier du projet : refus.
  const s = sessions.start({ name: 'cand-deux', path: WT_PATH, chantier: 'w' }, 80, 24);
  ws.send(JSON.stringify({ type: 'remove-project', project: 'cand-deux' }));
  await waitFor(() => errors() >= 1);
  assert.match(msgs.filter((m) => m.type === 'error').at(-1).message, /session/);
  assert.deepEqual(dropped, []);
  // Inconnu ou mal formé : refus.
  for (const bad of ['inexistant', 42, null]) ws.send(JSON.stringify({ type: 'remove-project', project: bad }));
  await waitFor(() => errors() >= 4);
  assert.deepEqual(dropped, []);
  sessions.close(s.id);
  ws.send(JSON.stringify({ type: 'remove-project', project: 'cand-deux' }));
  await waitFor(() => msgs.some((m) => m.type === 'project-removed'));
  assert.deepEqual(msgs.find((m) => m.type === 'project-removed'), { type: 'project-removed', name: 'cand-deux' });
  assert.deepEqual(dropped, ['cand-deux']);
  await waitFor(() => msgs.filter((m) => m.type === 'sessions').at(-1).sessions.every((c) => c.project !== 'cand-deux'));
  // Il redevient candidat à l'ajout.
  ws.send(JSON.stringify({ type: 'list-candidates' }));
  await waitFor(() => msgs.filter((m) => m.type === 'candidates').at(-1)?.candidates.some((c) => c.name === 'cand-deux'));
  // Retirer tous les autres, puis le dernier : refusé.
  const others = msgs.filter((m) => m.type === 'sessions').at(-1).sessions.map((c) => c.project).filter((n, i, a) => a.indexOf(n) === i);
  for (const n of others.slice(1)) ws.send(JSON.stringify({ type: 'remove-project', project: n }));
  await waitFor(() => dropped.length === others.length);
  const before = errors();
  ws.send(JSON.stringify({ type: 'remove-project', project: others[0] }));
  await waitFor(() => errors() > before);
  assert.match(msgs.filter((m) => m.type === 'error').at(-1).message, /dernier/);
  assert.equal(dropped.length, others.length);
  ws.close();
});

// ---------- Liens vers les fichiers cités par l'agent (src/files.js) ----------

async function startedSession() {
  const { ws, msgs } = await openCollect();
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  await waitFor(() => msgs.some((m) => m.type === 'started'));
  return { ws, msgs, id: msgs.find((m) => m.type === 'started').id };
}
const fixture = (name) => fs.realpathSync.native(path.join(process.cwd(), 'test', 'fixtures', name));

test('WS : resolve-paths résout dans le dossier de la session, ignore le reste ; sans session → erreur', async () => {
  closeAll();
  const lone = await openCollect();
  lone.ws.send(JSON.stringify({ type: 'resolve-paths', paths: ['test/fixtures/pixel.png'] }));
  await waitFor(() => lone.msgs.some((m) => m.type === 'error'));
  lone.ws.close();

  const { ws, msgs } = await startedSession();
  ws.send(JSON.stringify({
    type: 'resolve-paths',
    paths: ['test/fixtures/lignes.txt:3', 'test/fixtures/pixel.png', 'test/fixtures', 'test/fixtures/page.html',
      '../../Windows/win.ini', 'test/absent.js', 'mot', 42],
  }));
  await waitFor(() => msgs.some((m) => m.type === 'paths-resolved'));
  const { items } = msgs.find((m) => m.type === 'paths-resolved');
  assert.deepEqual(items['test/fixtures/lignes.txt:3'], { abs: fixture('lignes.txt'), kind: 'text', line: 3 });
  assert.equal(items['test/fixtures/pixel.png'].kind, 'image');
  assert.equal(items['test/fixtures'].kind, 'dir');
  assert.equal(items['test/fixtures/page.html'].kind, 'html');
  assert.deepEqual(Object.keys(items).sort(),
    ['test/fixtures', 'test/fixtures/lignes.txt:3', 'test/fixtures/page.html', 'test/fixtures/pixel.png']);

  ws.send(JSON.stringify({ type: 'resolve-paths', paths: Array.from({ length: 201 }, () => 'a/b.js') }));
  await waitFor(() => msgs.some((m) => m.type === 'error'));
  ws.close();
  closeAll();
});

test('WS : os-open seulement pour html/doc ; jamais un script ; reveal pour tout fichier résolu', async () => {
  closeAll();
  launched.length = 0;
  const { ws, msgs } = await startedSession();
  const errors = () => msgs.filter((m) => m.type === 'error').length;
  ws.send(JSON.stringify({ type: 'os-open', path: 'test/fixtures/script.ps1' }));
  await waitFor(() => errors() === 1);
  ws.send(JSON.stringify({ type: 'os-open', path: 'test/fixtures/lignes.txt' }));
  await waitFor(() => errors() === 2);
  ws.send(JSON.stringify({ type: 'os-open', path: '../../Windows/win.ini' }));
  await waitFor(() => errors() === 3);
  assert.deepEqual(launched, [], 'rien lancé');

  ws.send(JSON.stringify({ type: 'os-open', path: 'test/fixtures/page.html' }));
  ws.send(JSON.stringify({ type: 'reveal', path: 'test/fixtures/script.ps1' }));
  await waitFor(() => launched.length === 2);
  assert.deepEqual(launched, [['open', fixture('page.html')], ['reveal', fixture('script.ps1')]]);
  ws.close();
  closeAll();
});

test('WS : open-file refusé pour une image ou hors dossier (le cas valide est testé avec un vrai nvim)', async () => {
  closeAll();
  const { ws, msgs } = await startedSession();
  ws.send(JSON.stringify({ type: 'open-file', path: 'test/fixtures/pixel.png' }));
  ws.send(JSON.stringify({ type: 'open-file', path: '../../Windows/win.ini' }));
  await waitFor(() => msgs.filter((m) => m.type === 'error').length === 2);
  ws.close();
  closeAll();
});

test('/api/file : cookie exigé ; image de la session servie avec CSP ; texte, hors dossier ou session inconnue → 404', async () => {
  closeAll();
  const { ws, id } = await startedSession();
  const c = await cookie();
  const q = (p, sid = id) => `/api/file?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`;
  assert.equal((await get(q('test/fixtures/pixel.png'))).status, 401);
  const ok = await get(q('test/fixtures/pixel.png'), { cookie: c });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(q('test/fixtures/lignes.txt'), { cookie: c })).status, 404);
  assert.equal((await get(q('../../Windows/win.ini'), { cookie: c })).status, 404);
  assert.equal((await get(q('test/fixtures/pixel.png', 'inconnue'), { cookie: c })).status, 404);
  ws.close();
  closeAll();
});
