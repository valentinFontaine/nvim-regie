// Note de chantier : <notesDir>\<dossier du projet>\chantiers\<branche>.md, en lecture seule.
// Le nom de fichier vient de la branche (lue dans .git/HEAD) : validé strictement, jamais de chemin du client.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 100 * 1024;
const MAX_EXCERPT = 300;
const MAX_BRANCH = 100;
const FIELDS = ['Objectif', 'Prochaine commande'];

/** Chemin de la note, ou null si la branche, le projet ou notesDir sont douteux. */
export function noteFile(notesDir, projectPath, branch) {
  if (typeof notesDir !== 'string' || !path.isAbsolute(notesDir)) return null;
  if (typeof projectPath !== 'string' || typeof branch !== 'string') return null;
  if (!branch || branch.length > MAX_BRANCH) return null;
  const name = branch.replaceAll('/', '-');
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name) || name.includes('..')) return null;
  const project = path.basename(projectPath);
  if (!project || !/^[\w .-]+$/.test(project) || /^\.+$/.test(project)) return null;
  const root = path.resolve(notesDir);
  const file = path.resolve(root, project, 'chantiers', `${name}.md`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** Contenu de la note, ou null (absente, illisible, trop grosse). */
export function readNote(notesDir, projectPath, branch) {
  const file = noteFile(notesDir, projectPath, branch);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Extrait pour la carte : champs « **Objectif** : … » et « **Prochaine commande** : … », sinon début de la note. */
export function noteExcerpt(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const lines = [];
  for (const f of FIELDS) {
    const m = new RegExp(`^\\*\\*${f}\\*\\*\\s*:\\s*(.+)$`, 'mi').exec(text);
    if (m) lines.push(`${f} : ${m[1].trim()}`);
  }
  const out = lines.length ? lines.join('\n') : text.trim();
  return out.slice(0, MAX_EXCERPT);
}
