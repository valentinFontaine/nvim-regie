import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { attach } from 'neovim';
import { cleanEnv } from './env.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROMPT = 200 * 1024;
const CONNECT_TIMEOUT_MS = 20000;

/** Texte du buffer de prompt -> texte à coller, ou null s'il n'y a rien à envoyer.
 *  Retire tout ESC : sinon un `\x1b[201~` collé fermerait le bracketed paste de claude. */
export function sanitizePrompt(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\r\n?/g, '\n').replaceAll('\x1b', '').replace(/\s+$/, '');
  if (clean.trim() === '' || clean.length > MAX_PROMPT) return null;
  return clean;
}

export function pasteSequence(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

function pipeName(id) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nvim-regie-${id}`
    : path.join(os.tmpdir(), `nvim-regie-${id}.sock`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function tryConnect(address) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(address);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

/** Un nvim (pty + RPC) lié à une session. Ne construit jamais de commande à partir de données reçues. */
export class NvimBridge {
  constructor({ path: nvimPath, lua, sendKey, id, cols, rows, cwd, extraArgs = [], onSend, onData, onExit }) {
    if (!SAFE_ID.test(id)) throw new Error('id nvim invalide');
    this.address = pipeName(id);
    this.onSend = onSend;
    this.nvim = null;
    this.killed = false;
    this.pty = pty.spawn(nvimPath, ['--listen', this.address, ...extraArgs, '--cmd', 'lua dofile(vim.env.REGIE_LUA)'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...cleanEnv(), REGIE_LUA: lua, REGIE_SEND_KEY: sendKey },
      useConpty: true,
      useConptyDll: true,
    });
    this.pty.onData(onData);
    this.exited = false;
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      onExit(exitCode);
    });
    this.ready = this.#connect();
    this.ready.catch(() => {}); // l'erreur reste lisible par qui attend `ready`
  }

  async #connect() {
    const t0 = Date.now();
    let sock = null;
    let lastErr = null;
    while (!sock) {
      if (this.killed || this.exited) throw new Error('nvim arrêté avant la connexion RPC');
      if (Date.now() - t0 > CONNECT_TIMEOUT_MS) throw new Error(`connexion RPC à nvim impossible : ${lastErr?.message ?? 'délai'}`);
      try { sock = await tryConnect(this.address); } catch (e) { lastErr = e; await wait(100); }
    }
    this.sock = sock;
    sock.on('error', () => {});
    const nvim = attach({ reader: sock, writer: sock });
    nvim.on('notification', (method) => { if (method === 'regie_send') this.#send().catch(() => {}); });
    nvim.on('request', (_m, _a, resp) => resp.send('non géré', true));
    this.nvim = nvim;
    // Attend que le Lua du projet ait fini son VimEnter (buffer de prompt prêt).
    while (!(await nvim.eval('get(g:, "regie_prompt_buf", 0)'))) {
      if (Date.now() - t0 > CONNECT_TIMEOUT_MS) throw new Error('le Lua nvim-regie ne s\'est pas chargé');
      await wait(100);
    }
    await nvim.setVar('regie_chan', await nvim.channelId);
  }

  async #send() {
    const lines = await this.nvim.lua('return _G.regie_get_prompt()');
    const text = sanitizePrompt(lines.join('\n'));
    if (text === null) return;
    this.onSend(text);
    await this.nvim.lua('_G.regie_clear_prompt()');
  }

  async setAnswer(text) {
    await this.ready;
    await this.nvim.lua('return _G.regie_set_answer(...)', [String(text).split('\n')]);
  }

  write(data) { if (!this.exited) this.pty.write(data); }
  resize(cols, rows) { if (!this.exited) this.pty.resize(cols, rows); }

  kill() {
    this.killed = true;
    try { this.sock?.end(); } catch { /* déjà fermé */ }
    if (!this.exited) {
      try { this.pty.kill(); } catch { /* déjà mort */ }
    }
  }
}
