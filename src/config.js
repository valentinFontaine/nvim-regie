import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function configDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'nvim-regie');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

const DEFAULT_NOTES_DIR = 'C:\\Users\\irpaui\\OneDrive - Ingersoll Rand\\notes_Claude';

const EXEMPLE = {
  port: 47600,
  projects: [],
  nvimPath: 'C:\\Users\\irpaui\\Documents\\Programmes\\Neovim\\bin\\nvim.exe',
};

/** Valide un projet {name, path} ; `names` (Set) reçoit son nom. Lève une Error au message clair. */
export function validateProject(p, names, label = 'projet') {
  if (!p || typeof p.name !== 'string' || !/^[\w .-]{1,64}$/.test(p.name)) {
    throw new Error(`config.json : ${label}.name invalide`);
  }
  if (names.has(p.name)) throw new Error(`config.json : nom de projet en double : ${p.name}`);
  if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) {
    throw new Error(`config.json : ${label}.path doit être un chemin absolu`);
  }
  const resolved = path.resolve(p.path);
  let st;
  try { st = fs.statSync(resolved); } catch { st = null; }
  if (!st || !st.isDirectory()) throw new Error(`config.json : dossier introuvable : ${resolved}`);
  names.add(p.name);
  return { name: p.name, path: resolved };
}

/**
 * Ajoute un projet à config.json : relit le fichier, valide, n'écrit que `projects` (les autres clés,
 * même inconnues, sont conservées), écriture atomique (fichier temporaire puis rename).
 */
export function addProject(file, project) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`config.json illisible (${file}) : ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.projects)) throw new Error('config.json : "projects" absent');
  const names = new Set(raw.projects.map((p) => p?.name));
  const added = validateProject(project, names, 'projet');
  const lower = (p) => path.resolve(String(p)).toLowerCase();
  if (raw.projects.some((p) => typeof p?.path === 'string' && lower(p.path) === lower(added.path))) {
    throw new Error(`config.json : dossier déjà suivi : ${added.path}`);
  }
  const next = { ...raw, projects: [...raw.projects, added] };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* déjà absent */ }
    throw e;
  }
  return added;
}

/** Valide et normalise une config brute. Lève une Error au message clair. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config.json : objet attendu');
  const port = raw.port ?? 47600;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('config.json : "port" doit être un entier entre 1024 et 65535');
  }
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error('config.json : "projects" doit contenir au moins un projet {name, path}');
  }
  const names = new Set();
  const projects = raw.projects.map((p, i) => validateProject(p, names, `projects[${i}]`));
  const nvimPath = raw.nvimPath ?? EXEMPLE.nvimPath;
  if (typeof nvimPath !== 'string' || !path.isAbsolute(nvimPath)) {
    throw new Error('config.json : "nvimPath" doit être un chemin absolu');
  }
  if (!fs.existsSync(nvimPath)) throw new Error(`config.json : "nvimPath" introuvable : ${nvimPath}`);
  const sendKey = raw.sendKey ?? '<leader><CR>';
  if (typeof sendKey !== 'string' || sendKey.length < 1 || sendKey.length > 32) {
    throw new Error('config.json : "sendKey" doit être une chaîne de 1 à 32 caractères (ex. "<leader><CR>")');
  }
  // Dossier des notes (lecture seule) : absent ou introuvable n'est pas une erreur, les cartes n'ont alors pas de note.
  const notesDir = raw.notesDir ?? DEFAULT_NOTES_DIR;
  if (typeof notesDir !== 'string' || !path.isAbsolute(notesDir)) {
    throw new Error('config.json : "notesDir" doit être un chemin absolu');
  }
  return { port, projects, nvimPath, sendKey, notesDir };
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(EXEMPLE, null, 2));
    throw new Error(`Config créée : ${file}\nAjoute au moins un projet dans "projects" ({"name":"…","path":"C:\\\\…"}) puis relance.`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`config.json illisible (${file}) : ${e.message}`);
  }
  return validateConfig(raw);
}
