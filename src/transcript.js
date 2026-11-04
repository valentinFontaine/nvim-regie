import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULT = 20_000;
const MAX_INPUT_STRING = 4_000;

export function defaultProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Encodage observé (claude 2.1.318) : tout caractère hors [A-Za-z0-9] devient « - ». */
export function encodeProjectDir(projectPath) {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Trouve le fichier de transcript d'une session. `sessionId` est validé (UUID) avant
 * toute opération sur le système de fichiers. Retourne null si le fichier n'existe pas encore.
 */
export function findTranscript(root, projectPath, sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new Error('id de session invalide');
  const name = `${sessionId}.jsonl`;
  const direct = path.join(root, encodeProjectDir(projectPath), name);
  if (fs.existsSync(direct)) return direct;
  // Filet de sécurité si l'encodage diffère : chercher dans les sous-dossiers directs.
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function parseLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n… [tronqué : ${s.length - max} caractères]` : s;
}

function capInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? truncate(v, MAX_INPUT_STRING) : v;
  return out;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
    if (b.type === 'image') return '[image]';
    if (b.type === 'document') return '[document]';
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Normalise une ligne JSONL en items d'affichage. Tolérant : ce qui n'est pas reconnu
 * est ignoré, aucune exception.
 */
export function toItems(entry) {
  try {
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) return [];
    if (entry.isMeta || entry.isSidechain) return [];
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') return [];
    const role = entry.type;
    const msgId = (role === 'assistant' && typeof msg.id === 'string' ? msg.id : entry.uuid) ?? null;
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    const base = { msgId, role, ts };
    const content = msg.content;
    if (typeof content === 'string') return content ? [{ ...base, kind: 'text', text: content }] : [];
    if (!Array.isArray(content)) return [];
    const items = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        items.push({ ...base, kind: 'text', text: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        items.push({ ...base, kind: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        items.push({ ...base, kind: 'tool_use', toolUseId: b.id, name: String(b.name ?? '?'), input: capInput(b.input) });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        items.push({
          ...base, kind: 'tool_result', toolUseId: b.tool_use_id,
          text: truncate(resultText(b.content), MAX_RESULT), isError: b.is_error === true,
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Suit un fichier JSONL par sondage de `stat` (plus robuste que fs.watch sous Windows).
 * `resolve()` retourne le chemin ou null (le fichier n'existe qu'après le premier prompt).
 * La dernière ligne incomplète est gardée en réserve jusqu'au prochain passage.
 */
export class TranscriptTail {
  constructor({ resolve, onItems, intervalMs = 500 }) {
    this.resolve = resolve;
    this.onItems = onItems;
    this.intervalMs = intervalMs;
    this.file = null;
    this.offset = 0;
    this.rest = '';
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async #poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.file) {
        this.file = this.resolve();
        if (!this.file) return;
        this.offset = 0;
        this.rest = '';
      }
      let st;
      try { st = await fs.promises.stat(this.file); } catch { return; }
      if (st.size < this.offset) { this.offset = 0; this.rest = ''; }
      if (st.size === this.offset) return;
      const fh = await fs.promises.open(this.file, 'r');
      try {
        const len = st.size - this.offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        this.offset += bytesRead;
        // Découpe sur les octets 0x0A avant décodage : ne coupe jamais un caractère UTF-8.
        const chunk = Buffer.concat([Buffer.from(this.rest, 'latin1'), buf.subarray(0, bytesRead)]);
        const lastNl = chunk.lastIndexOf(0x0a);
        if (lastNl < 0) { this.rest = chunk.toString('latin1'); return; }
        this.rest = chunk.subarray(lastNl + 1).toString('latin1');
        const text = chunk.subarray(0, lastNl).toString('utf8');
        const items = text.split('\n').map(parseLine).filter(Boolean).flatMap(toItems);
        if (items.length) this.onItems(items);
      } finally {
        await fh.close();
      }
    } catch { /* un passage raté sera retenté */ } finally {
      this.busy = false;
    }
  }
}
