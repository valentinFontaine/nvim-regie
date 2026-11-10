// Dossiers proposables à l'ajout : les clés de `projects` dans ~/.claude.json (vrais chemins, là où claude
// a déjà été lancé), moins ce qui n'a pas sa place dans la liste (disparus, worktrees, Temp, déjà suivis).
// Lecture seule : l'écriture de config.json est dans config.js (addProject).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_MAX = 64;

const norm = (p) => path.resolve(p).toLowerCase();

function isUnder(child, root) {
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Nom proposé : dernier segment du chemin, caractères hors /[\w .-]/ remplacés, suffixe « 2 », « 3 »… si pris. */
export function suggestName(dir, taken) {
  const base = path.basename(path.resolve(dir)) || 'projet';
  let name = base.replace(/[^\w .-]+/g, '-').replace(/^[ -]+|[ -]+$/g, '').slice(0, NAME_MAX - 4) || 'projet';
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const cand = `${name} ${i}`;
    if (!taken.has(cand)) return cand;
  }
}

/**
 * @param {{claudeJson?: string, tracked: {name:string, path:string}[], excludeRoots?: string[]}} o
 * @returns {{path:string, name:string}[]} triés par nom ; jamais d'exception (fichier absent ou illisible → []).
 */
export function listCandidates({ claudeJson = path.join(os.homedir(), '.claude.json'), tracked = [], excludeRoots = [os.tmpdir()] } = {}) {
  let keys;
  try {
    const raw = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    const projects = raw?.projects;
    keys = projects && typeof projects === 'object' && !Array.isArray(projects) ? Object.keys(projects) : [];
  } catch {
    return [];
  }
  const have = new Set(tracked.map((p) => norm(p.path)));
  const taken = new Set(tracked.map((p) => p.name));
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !path.isAbsolute(key)) continue;
    const p = path.resolve(key);
    const n = norm(p);
    if (seen.has(n) || have.has(n)) continue;
    seen.add(n);
    if (excludeRoots.some((r) => isUnder(p, r))) continue;
    if (p.split(path.sep).some((seg, i, a) => seg.toLowerCase() === 'worktrees' && a[i - 1]?.toLowerCase() === '.claude')) continue;
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    out.push(p);
  }
  out.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
  return out.map((p) => {
    const name = suggestName(p, taken);
    taken.add(name);
    return { path: p, name };
  });
}
