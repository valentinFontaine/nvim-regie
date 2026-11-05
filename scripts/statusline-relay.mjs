#!/usr/bin/env node
// Relais de statusLine, injecté par nvim-regie via `claude --settings`.
// Usage : node statusline-relay.mjs <port> <jeton> <id-session>
// 1. lit sur stdin le JSON que claude donne à toute statusLine ;
// 2. exécute la statusLine de l'utilisateur (~/.claude/settings.json) avec ce même JSON,
//    comme le ferait claude : le terminal garde exactement la même barre ;
// 3. recopie sa sortie sur stdout et la poste au serveur local, qui l'affiche dans l'interface.
// La commande exécutée vient du fichier de réglages de l'utilisateur, jamais de données reçues.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const [port, token, id] = process.argv.slice(2);
const TIMEOUT_MS = 5000;
const MAX_TEXT = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function userCommand() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const c = s?.statusLine;
    if (c?.type !== 'command' || typeof c.command !== 'string') return null;
    // Garde-fou : ne jamais se rappeler soi-même.
    return c.command.includes('statusline-relay') ? null : c.command;
  } catch {
    return null;
  }
}

function runUser(command, input) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(out); } };
    let p;
    try {
      p = spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return finish();
    }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* déjà fini */ } finish(); }, TIMEOUT_MS);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', finish);
    p.on('close', () => { clearTimeout(timer); finish(); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

function postStatus(text) {
  return new Promise((resolve) => {
    if (!/^\d+$/.test(port ?? '') || !/^[0-9a-f]{64}$/i.test(token ?? '') || !/^[0-9a-f-]{36}$/i.test(id ?? '')) return resolve();
    const body = JSON.stringify({ text: text.slice(0, MAX_TEXT) });
    const req = http.request({
      host: '127.0.0.1', port: Number(port), path: `/status/${token}/${id}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(body);
  });
}

const input = await readStdin();
const command = userCommand();
const text = command ? await runUser(command, input) : '';
process.stdout.write(text);
await postStatus(text);
