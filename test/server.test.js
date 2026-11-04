import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session.js';

const PORT = 47655;
const token = 'a'.repeat(64);
let app;

before(async () => {
  const sessions = new SessionManager({
    command: process.execPath,
    args: () => ['-e', "process.stdout.write('READY\\n');setInterval(()=>{},1000)"],
  });
  app = createApp({
    config: { port: PORT, projects: [{ name: 'demo', path: process.cwd() }] },
    token,
    sessions,
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
