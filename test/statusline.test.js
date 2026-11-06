import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, hooksSettings } from '../src/server.js';
import { SessionManager } from '../src/session.js';

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'statusline-relay.mjs');
const PORT = 47657;
const token = 'a'.repeat(64);
const ID = '22222222-2222-4222-8222-222222222222';
const echoer = { command: process.execPath, args: () => ['-e', "process.stdout.write('READY\\n');setInterval(()=>{},1000)"] };
let app;
let sessions;

before(async () => {
  sessions = new SessionManager(echoer);
  app = createApp({ config: { port: PORT, projects: [{ name: 'demo', path: process.cwd() }] }, token, sessions, pastSessions: () => [] });
  await app.listen();
});
after(async () => { sessions.killAll(); await app.close(); });

function post(p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('hooksSettings : statusLine relayée vers le serveur (jeton et id dans la commande)', () => {
  const s = JSON.parse(hooksSettings(PORT, token, ID));
  assert.ok(s.hooks.Stop, 'hooks conservés');
  assert.equal(s.statusLine.type, 'command');
  assert.match(s.statusLine.command, /statusline-relay\.mjs/);
  assert.ok(s.statusLine.command.includes(`${PORT} ${token} ${ID}`));
});

test('hooksSettings : résumés de réflexion demandés (sinon le thinking est vide dans le JSONL)', () => {
  const s = JSON.parse(hooksSettings(PORT, token, ID));
  assert.equal(s.showThinkingSummaries, true);
});

test('setStatus : barre de statut diffusée, rejouée à un nouvel abonné, tronquée', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  s.setStatus('12k/200k');
  assert.deepEqual(got.at(-1), { type: 'status', text: '12k/200k' });
  const late = [];
  s.subscribe((msg) => late.push(msg));
  assert.ok(late.some((x) => x.type === 'status' && x.text === '12k/200k'));
  s.setStatus('x'.repeat(5000));
  assert.ok(s.status.length <= 2000);
  m.killAll();
});

test('route /status : texte appliqué à la session, jeton et id exigés', async () => {
  const s = sessions.start({ name: 'demo', path: process.cwd() }, 80, 24);
  const url = (t, id) => `/status/${t}/${id}`;
  assert.equal(await post(url(token, s.id), { text: '12k/200k | 5h ██░ 20%' }), 204);
  assert.equal(s.status, '12k/200k | 5h ██░ 20%');
  assert.equal(await post(url('b'.repeat(64), s.id), { text: 'x' }), 401);
  assert.equal(await post(url(token, '00000000-0000-4000-8000-000000000000'), { text: 'x' }), 404);
  assert.equal(await post(url(token, s.id), { text: 42 }), 400);
  assert.equal(await post(url(token, s.id), 'pas du json'), 400);
  assert.equal(await post(url(token, s.id), { text: 'x' }, { host: 'evil.test' }), 403);
  assert.equal(s.status, '12k/200k | 5h ██░ 20%');
});

function runRelay(home, port, input) {
  return new Promise((resolve) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const p = spawn(process.execPath, [RELAY, String(port), token, ID], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(input);
  });
}

test("relais : exécute la statusLine de l'utilisateur, rend sa sortie et la poste au serveur", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const userScript = path.join(home, 'sl.js');
  fs.writeFileSync(userScript, "let r='';process.stdin.on('data',d=>r+=d);process.stdin.on('end',()=>process.stdout.write('\\x1b[31mmodele '+JSON.parse(r).model.id+'\\x1b[0m'))");
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `"${process.execPath}" "${userScript}"` },
  }));
  const posts = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { posts.push({ url: req.url, body: JSON.parse(b) }); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { code, out } = await runRelay(home, port, JSON.stringify({ model: { id: 'opus' } }));
  server.close();
  assert.equal(code, 0);
  assert.equal(out, '\x1b[31mmodele opus\x1b[0m');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `/status/${token}/${ID}`);
  assert.equal(posts[0].body.text, out);
});

test('relais : sans statusLine utilisateur ni serveur joignable, sort proprement sans rien afficher', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-home-'));
  const { code, out } = await runRelay(home, 1, '{}');
  assert.equal(code, 0);
  assert.equal(out, '');
});
