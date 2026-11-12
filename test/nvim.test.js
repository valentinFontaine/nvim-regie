import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizePrompt, pasteSequence, NvimBridge } from '../src/nvim.js';
import { SessionManager } from '../src/session.js';
import { validateConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LUA = path.join(ROOT, 'nvim', 'regie.lua');
const NVIM = process.env.NVIM_PATH || 'C:\\Users\\irpaui\\Documents\\Programmes\\Neovim\\bin\\nvim.exe';
const haveNvim = fs.existsSync(NVIM);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return; await wait(50); }
  assert.fail('délai dépassé');
}
async function pressSend(nvim) {
  await nvim.command('stopinsert');
  await nvim.input('<F9>');
}

test('sanitizePrompt : retire ESC, normalise les fins de ligne, ignore le vide', () => {
  assert.equal(sanitizePrompt('a\r\nb'), 'a\nb');
  assert.equal(sanitizePrompt('x\x1b[201~y'), 'x[201~y');
  assert.equal(sanitizePrompt('  \n \n'), null);
  assert.equal(sanitizePrompt(''), null);
  assert.equal(sanitizePrompt('ligne\n\n'), 'ligne');
});

test('pasteSequence : bracketed paste', () => {
  assert.equal(pasteSequence('abc'), '\x1b[200~abc\x1b[201~');
});

test('config : sendKey et nvimPath validés', () => {
  const base = { projects: [{ name: 'p', path: process.cwd() }] };
  assert.equal(validateConfig(base).sendKey, '<leader><CR>');
  assert.equal(validateConfig({ ...base, sendKey: '<C-s>' }).sendKey, '<C-s>');
  assert.throws(() => validateConfig({ ...base, sendKey: 42 }), /sendKey/);
  assert.throws(() => validateConfig({ ...base, sendKey: 'x'.repeat(80) }), /sendKey/);
  assert.throws(() => validateConfig({ ...base, nvimPath: 'Z:\\nexiste\\pas\\nvim.exe' }), /nvimPath/);
});

// Les tests Nvim utilisent --clean et <F9> : indépendants de la config utilisateur.
test('NvimBridge : envoi du buffer, vidage, réponse en lecture seule', { skip: !haveNvim }, async () => {
  const sent = [];
  const bridge = new NvimBridge({
    path: NVIM, lua: LUA, sendKey: '<F9>', extraArgs: ['--clean'], id: `test-${process.pid}`,
    cols: 100, rows: 30, cwd: process.cwd(),
    onSend: (text) => sent.push(text),
    onData: () => {}, onExit: () => {},
  });
  try {
    await bridge.ready;
    const nvim = bridge.nvim;
    const buf = await nvim.buffer;
    await buf.setLines(['bonjour', 'a\x1b[201~b', '```js', 'x', '```'], { start: 0, end: -1, strictIndexing: false });
    await pressSend(nvim);
    await until(() => sent.length === 1);
    assert.equal(sent[0], 'bonjour\na[201~b\n```js\nx\n```');
    await until(async () => (await buf.lines).join('') === '');
    await bridge.setAnswer('# Titre\nligne 2');
    const lines = await nvim.lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr("regie://reponse"), 0, -1, false)');
    assert.deepEqual(lines, ['# Titre', 'ligne 2']);
    const modifiable = await nvim.lua('return vim.bo[vim.fn.bufnr("regie://reponse")].modifiable');
    assert.equal(modifiable, false);
  } finally {
    bridge.kill();
  }
});

test('NvimBridge : brouillon notifié au changement seulement (non vide / vide / envoi)', { skip: !haveNvim }, async () => {
  const drafts = [];
  const bridge = new NvimBridge({
    path: NVIM, lua: LUA, sendKey: '<F9>', extraArgs: ['--clean'], id: `draft-${process.pid}`,
    cols: 100, rows: 30, cwd: process.cwd(),
    onSend: () => {}, onDraft: (v) => drafts.push(v),
    onData: () => {}, onExit: () => {},
  });
  try {
    await bridge.ready;
    const nvim = bridge.nvim;
    const buf = await nvim.buffer;
    const set = (lines) => buf.setLines(lines, { start: 0, end: -1, strictIndexing: false });
    await set(['  ', '']);
    await wait(300);
    assert.deepEqual(drafts, [], 'lignes blanches : pas de brouillon');
    await set(['un mot']);
    await until(() => drafts.length === 1);
    await set(['un mot de plus']);
    await wait(300);
    assert.deepEqual(drafts, [true], 'pas de nouvelle notification tant que rien ne change');
    await pressSend(nvim);
    await until(() => drafts.length === 2);
    assert.deepEqual(drafts, [true, false], "l'envoi vide le buffer");
  } finally {
    bridge.kill();
  }
});

test('Session : le prompt Nvim arrive dans le pty de claude en bracketed paste puis \\r', { skip: !haveNvim }, async () => {
  const fake = "process.stdin.setRawMode&&process.stdin.setRawMode(true);"
    + "process.stdin.on('data',d=>process.stdout.write('GOT:'+JSON.stringify(String(d))+'\\n'));"
    + "process.stdout.write('READY\\n')";
  const m = new SessionManager({
    command: process.execPath,
    args: () => ['-e', fake],
    nvim: { path: NVIM, lua: LUA, sendKey: '<F9>', extraArgs: ['--clean'] },
  });
  const got = [];
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.subscribe((msg) => got.push(msg));
  try {
    await until(() => got.some((x) => x.type === 'data' && x.data.includes('READY')));
    await s.nvimReady;
    const nvim = s.bridge.nvim;
    const buf = await nvim.buffer;
    await buf.setLines(['ligne1', 'ligne2'], { start: 0, end: -1, strictIndexing: false });
    await pressSend(nvim);
    const all = () => got.filter((x) => x.type === 'data').map((x) => x.data).join('');
    await until(() => all().includes('GOT:"\\r"'));
    assert.ok(all().includes('\\u001b[200~ligne1\\nligne2\\u001b[201~'), all());
  } finally {
    m.killAll();
  }
});

test('Session : nvim-data relayé aux abonnés, avec rejeu', { skip: !haveNvim }, async () => {
  const m = new SessionManager({
    command: process.execPath,
    args: () => ['-e', 'setInterval(()=>{},1000)'],
    nvim: { path: NVIM, lua: LUA, sendKey: '<F9>', extraArgs: ['--clean'] },
  });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  try {
    await s.nvimReady;
    await until(() => s.nvimBuffer.length > 0);
    const got = [];
    s.subscribe((msg) => got.push(msg));
    assert.ok(got.some((x) => x.type === 'nvim-data'));
  } finally {
    m.killAll();
  }
});
