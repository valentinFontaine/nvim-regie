// Chantiers : worktrees git sous <projet>/.claude/worktrees/<nom>, sur la branche du même nom.
// Jamais de shell : `git` est lancé avec un tableau d'arguments, le nom est validé strictement.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readBranch } from './git.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 40;
const RESERVED = ['main', 'master', 'head'];
const MAX_ERR = 300;
const EXCLUDE_LINE = '.claude/worktrees/';

export function cleanChantierName(name) {
  if (typeof name !== 'string') throw new TypeError('nom de chantier invalide');
  const t = name.trim();
  if (t.length > MAX_NAME || !NAME_RE.test(t) || RESERVED.includes(t)) throw new TypeError('nom de chantier invalide');
  return t;
}

const worktreesDir = (project) => path.join(project.path, '.claude', 'worktrees');

export function chantierPath(project, name) {
  return path.join(worktreesDir(project), cleanChantierName(name));
}

/** Sous-dossiers de .claude/worktrees qui portent une entrée .git ; sans git, jamais d'exception. */
export function listChantiers(project) {
  try {
    const dir = worktreesDir(project);
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (!fs.existsSync(path.join(p, '.git'))) continue;
      out.push({ name: e.name, path: p, branch: readBranch(p) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').trim() || err.message;
        return reject(new Error(msg.slice(0, MAX_ERR)));
      }
      resolve(stdout);
    });
  });
}

function ensureExcluded(project) {
  const info = path.join(project.path, '.git', 'info');
  const file = path.join(info, 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
  if (cur.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return;
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
}

export async function createChantier(project, name) {
  const n = cleanChantierName(name);
  const p = chantierPath(project, n);
  if (fs.existsSync(p)) throw new Error('chantier déjà existant');
  ensureExcluded(project);
  await git(['worktree', 'add', '-b', n, p, 'HEAD'], project.path);
  return { name: n, path: p, branch: n };
}

export async function removeChantier(project, name, { hasLiveSession = false } = {}) {
  const n = cleanChantierName(name);
  const c = listChantiers(project).find((x) => x.name === n);
  if (!c) throw new Error('chantier inconnu');
  if (hasLiveSession) throw new Error('une session est encore ouverte dans ce chantier');
  const branch = c.branch ?? n;
  if ((await git(['status', '--porcelain'], c.path)).trim()) throw new Error('chantier non propre : fichiers modifiés');
  try {
    await git(['merge-base', '--is-ancestor', branch, 'HEAD'], project.path);
  } catch {
    throw new Error('branche non fusionnée');
  }
  await git(['worktree', 'remove', c.path], project.path);
  await git(['branch', '-d', branch], project.path);
}
