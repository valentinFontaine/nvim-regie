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

before(async () => {
  const sessions = new SessionManager({
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
