// Sessions passées d'un projet : les JSONL que claude écrit lui-même (~/.claude/projects/<dossier>/<uuid>.jsonl).
// Aucune donnée du client n'atteint le disque : `projectPath` vient de la config.
import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectDir, parseLine, toItems } from './transcript.js';

const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_TITLE = 80;
// Texte « utilisateur » qui n'est pas un vrai prompt : commandes slash, sortie locale, interruption.
const NOT_A_PROMPT = /^\s*(<command-|<local-command|<system-reminder|\[Request interrupted)/;

const cache = new Map(); // chemin -> {mtimeMs, size, info|null}

let scans = 0;
/** Nombre de fichiers lus depuis le début du processus (pour tester le cache). */
export const scanCount = () => scans;

const oneLine = (s) => String(s).split(/\r?\n/, 1)[0].trim().slice(0, MAX_TITLE);

/** {title} si la session contient un vrai message utilisateur, sinon null. Lit tout le fichier (ai-title loin du début). */
function scan(file) {
  scans++;
  let aiTitle = null;
  let firstPrompt = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('"type":"ai-title"')) {
      const o = parseLine(line);
      if (o && typeof o.aiTitle === 'string' && o.aiTitle.trim()) aiTitle = o.aiTitle.trim();
    } else if (firstPrompt === null && line.includes('"type":"user"')) {
      const it = toItems(parseLine(line)).find((i) => i.kind === 'text' && i.role === 'user' && !NOT_A_PROMPT.test(i.text));
      if (it) firstPrompt = it.text;
    }
  }
  if (firstPrompt === null) return null;
  return { title: oneLine(aiTitle ?? firstPrompt) };
}

/** Plus récente d'abord. Dossier absent ou illisible : []. */
export function listPastSessions(root, projectPath) {
  if (typeof root !== 'string' || typeof projectPath !== 'string' || !projectPath) return [];
  const dir = path.join(root, encodeProjectDir(projectPath));
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      let c = cache.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        c = { mtimeMs: st.mtimeMs, size: st.size, info: scan(file) };
        cache.set(file, c);
      }
      if (c.info) out.push({ id: m[1].toLowerCase(), title: c.info.title, mtime: st.mtimeMs, size: st.size });
    } catch { /* fichier disparu ou illisible : ignoré */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
