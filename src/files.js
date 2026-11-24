// Fichiers cités par l'agent : texte -> chemin sûr (parseRef), puis chemin réel dans le dossier de la session
// (resolveInside), puis catégorie d'action (classify). Le client ne désigne jamais qu'un texte : le serveur
// re-résout toujours lui-même.
import fs from 'node:fs';
import path from 'node:path';

const MAX_REF = 500;
const MAX_LINE = 9_999_999;

/** Texte cité -> { rel, line } ou null si ce n'est pas un chemin sûr (UNC, schéma, flux ADS, lecteur relatif…). */
export function parseRef(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s || s.length > MAX_REF) return null;
  if (/[\x00-\x1f\x7f\s]/.test(s)) return null; // NUL, retours ligne, espaces internes
  if (s.startsWith('\\\\') || s.startsWith('//')) return null; // UNC

  let line = null;
  const m = /(?::(\d+)(?::\d+)?|#L(\d+))$/.exec(s);
  if (m) {
    s = s.slice(0, m.index);
    const n = Number(m[1] ?? m[2]);
    line = n >= 1 && n <= MAX_LINE ? n : null;
  }
  if (!s) return null;

  // Lecteur : « C:\ » ou « C:/ » seulement ; « C:foo » est un chemin relatif au lecteur, refusé.
  let rest = s;
  if (/^[A-Za-z]:/.test(s)) {
    if (!/^[A-Za-z]:[\\/]/.test(s)) return null;
    rest = s.slice(2);
  }
  if (rest.includes(':')) return null; // schémas (http:, mailto:) et flux de données alternatifs
  if (/[<>"|?*]/.test(rest)) return null;
  if (!/[\\/]/.test(rest) && !/\.[A-Za-z0-9]+$/.test(rest)) return null; // un mot seul n'est pas un chemin
  return { rel: s, line };
}

/** Chemin réel de `rel` s'il existe strictement sous `root` (liens et jonctions suivis), sinon null. */
export function resolveInside(root, rel) {
  if (typeof root !== 'string' || typeof rel !== 'string' || !rel) return null;
  try {
    const realRoot = fs.realpathSync.native(root);
    const real = fs.realpathSync.native(path.resolve(realRoot, rel));
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (norm(real) === norm(realRoot) || !norm(real).startsWith(norm(prefix))) return null;
    return real;
  } catch {
    return null;
  }
}

/** Notes de l'utilisateur (hors dépôt) : « notes_Claude\… » (nom du dossier en tête) ou chemin absolu,
 *  résolus strictement sous notesDir. Un relatif sans ce préfixe reste l'affaire du dossier de la session. */
export function resolveInNotes(notesDir, rel) {
  if (typeof notesDir !== 'string' || !path.isAbsolute(notesDir) || typeof rel !== 'string') return null;
  if (path.isAbsolute(rel)) return resolveInside(notesDir, rel);
  const [head, ...rest] = rel.split(/[\\/]/);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!rest.length || norm(head) !== norm(path.basename(notesDir))) return null;
  return resolveInside(notesDir, rest.join(path.sep));
}

const KINDS = {
  html: ['.html', '.htm'],
  svg: ['.svg'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'],
  doc: ['.pdf', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.csv'],
  // Binaires et lanceurs : ni Neovim (illisible) ni application Windows (exécution) → Explorateur seulement.
  other: ['.exe', '.dll', '.lnk', '.url', '.zip', '.7z', '.rar', '.gz', '.tar', '.msi', '.scr', '.com', '.cpl',
    '.sys', '.bin', '.iso', '.jar', '.class', '.pyc', '.so', '.dylib', '.node', '.db', '.sqlite', '.mp3', '.mp4',
    '.wav', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.otf', '.xlsm', '.docm', '.pptm'],
};

/** Catégorie d'action : dir | text | html | svg | image | doc | other (jamais exécuté par nous).
 *  Extension inconnue ou absente (LICENSE, .go, .tsx…) → text : l'ouvrir dans Neovim ne lance rien. */
export function classify(abs, isDir) {
  if (isDir) return 'dir';
  const ext = path.extname(path.basename(String(abs))).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return 'text';
}
