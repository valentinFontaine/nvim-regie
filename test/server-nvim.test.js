import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NVIM = process.env.NVIM_PATH || 'C:\\Users\\irpaui\\Documents\\Programmes\\Neovim\\bin\\nvim.exe';
const PORT = 47656;
const token = 'b'.repeat(64);
let app;
let sessions;

before(async () => {
  sessions = new SessionManager({
    command: process.execPath,
    args: () => ['-e', 'setInterval(()=>{},1000)'],
    nvim: { path: NVIM, lua: path.join(ROOT, 'nvim', 'regie.lua'), sendKey: '<F9>', extraArgs: ['--clean'] },
  });
  app = createApp({ config: { port: PORT, projects: [{ name: 'demo', path: process.cwd() }] }, token, sessions });
  await app.listen();
});
after(async () => { await app.close(); });

function cookie() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: `/?token=${token}`, headers: { host: `127.0.0.1:${PORT}` } },
      (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }).on('error', reject);
  });
}

test('WS : nvim-data reçu, nvim-input et nvim-resize validés', { skip: !fs.existsSync(NVIM) }, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { cookie: await cookie(), origin: `http://127.0.0.1:${PORT}` },
  });
  const msgs = [];
  ws.on('message', (r) => msgs.push(JSON.parse(String(r))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  const until = async (fn) => {
    const t = Date.now();
    while (Date.now() - t < 15000) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
    assert.fail('délai dépassé');
  };
  await until(() => msgs.some((m) => m.type === 'nvim-data'));
  ws.send(JSON.stringify({ type: 'nvim-input', data: 42 }));
  await until(() => msgs.some((m) => m.type === 'error'));
  msgs.length = 0;
  ws.send(JSON.stringify({ type: 'nvim-resize', cols: 0, rows: 5 }));
  await until(() => msgs.some((m) => m.type === 'error'));
  ws.close();
});

test('WS : open-file ouvre le fichier dans un nouvel onglet nvim, à la ligne ; re-clic = même onglet ; prompt intact', { skip: !fs.existsSync(NVIM) }, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { cookie: await cookie(), origin: `http://127.0.0.1:${PORT}` },
  });
  const msgs = [];
  ws.on('message', (r) => msgs.push(JSON.parse(String(r))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'start', project: 'demo', cols: 80, rows: 24 }));
  const until = async (fn) => {
    const t = Date.now();
    while (Date.now() - t < 15000) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
    assert.fail('délai dépassé');
  };
  await until(() => msgs.some((m) => m.type === 'started'));
  const s = sessions.get(msgs.find((m) => m.type === 'started').id);
  await s.nvimReady;
  const nv = s.bridge.nvim;
  const file = fs.realpathSync.native(path.join(ROOT, 'test', 'fixtures', 'lignes.txt'));

  ws.send(JSON.stringify({ type: 'open-file', path: 'test/fixtures/lignes.txt:3' }));
  await until(async () => (await nv.eval('tabpagenr("$")')) === 2);
  assert.equal(path.resolve(await nv.eval('expand("%:p")')).toLowerCase(), file.toLowerCase());
  assert.equal(await nv.eval('line(".")'), 3);

  ws.send(JSON.stringify({ type: 'open-file', path: 'test/fixtures/lignes.txt:5' }));
  await until(async () => (await nv.eval('line(".")')) === 5);
  assert.equal(await nv.eval('tabpagenr("$")'), 2, 'pas de second onglet pour le même fichier');

  const promptBuf = await nv.eval('g:regie_prompt_buf');
  assert.equal(await nv.eval('tabpagebuflist(1)[0]'), promptBuf, 'onglet 1 = prompt');
  ws.close();
});
