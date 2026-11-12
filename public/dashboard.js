// Logique pure du tableau de bord (aucun DOM) : colonnes, tri, durées, compteur du titre.

export const COLUMNS = [
  { id: 'needs_you', label: 'Besoin de toi' },
  { id: 'running', label: 'En cours' },
  { id: 'done_unread', label: 'Terminé, non lu' },
  { id: 'idle', label: 'Au repos' },
];

/** Colonne d'une carte. `error` attire l'attention ; `stopped` (non lancé) et inconnu sont au repos. */
export function columnOf(state, draft = false) {
  if (state === 'needs_you' || state === 'error') return 'needs_you';
  if (state === 'running' || state === 'done_unread') return state;
  // Brouillon en cours dans Neovim : la session reste visible parmi les « terminé, non lu ».
  if (state === 'idle' && draft === true) return 'done_unread';
  return 'idle';
}

/** Badge « brouillon » d'une carte (buffer de prompt non vide) : {text} ou null. */
export function draftBadge(card) {
  return card && card.draft === true ? { text: '✎ brouillon' } : null;
}

// Depuis le plus ancien `since` (attente la plus longue) ; sans `since` en dernier ; égalités par projet puis key.
const byAge = (a, b) => {
  const x = a.since ?? Infinity;
  const y = b.since ?? Infinity;
  if (x !== y) return x < y ? -1 : 1;
  return String(a.project).localeCompare(String(b.project)) || String(a.key).localeCompare(String(b.key));
};

/** Sessions « écrivain » encore vivantes dans un lieu (dossier principal si chantier omis), pour l'avertissement. */
export function writersIn(cards, project, chantier = null) {
  return cards.filter((c) => c.project === project && (c.chantier ?? null) === chantier
    && c.mode === 'write' && c.state !== 'error' && c.state !== 'stopped').length;
}

/** Route du hash : '#/s/<id>' (session), '#/p/<projet>[/<chantier>]' (lieu sans session), sinon tableau de bord. */
export function parseRoute(hash) {
  const dash = { view: 'dash' };
  if (typeof hash !== 'string') return dash;
  const parts = hash.split('/');
  if (parts[0] !== '#') return dash;
  try {
    const seg = parts.slice(2).map(decodeURIComponent);
    if (parts[1] === 's' && seg.length === 1 && seg[0]) return { view: 'session', id: seg[0] };
    if (parts[1] === 'p' && seg.length >= 1 && seg.length <= 2 && seg.every(Boolean)) {
      return { view: 'place', project: seg[0], chantier: seg[1] ?? null };
    }
  } catch { /* encodage invalide */ }
  return dash;
}

/** Lien d'une carte : sa session si elle existe, sinon son lieu. */
export function cardHref(c) {
  if (c.id) return `#/s/${encodeURIComponent(c.id)}`;
  return `#/p/${encodeURIComponent(c.project)}${c.chantier ? `/${encodeURIComponent(c.chantier)}` : ''}`;
}

export const placeTitle = (c) => (c.chantier ? `${c.project} › ${c.chantier}` : c.project);

/** Nom court d'une session : son étiquette, sinon son mode. */
export function sessionName(c) {
  if (c.label) return c.label;
  if (c.mode === 'consult') return 'lecture';
  if (c.mode === 'write') return 'écrivain';
  return '';
}

export function groupByColumn(cards) {
  const g = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const c of cards) g[columnOf(c.state, c.draft)].push(c);
  for (const id of Object.keys(g)) g[id].sort(byAge);
  return g;
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Durée d'un tour, plus fine que formatDuration : « 11 s », « 1 min 8 s », « 1 h 02 min ». */
export function formatTurnDuration(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000)); // arrondi, comme le terminal (67,8 s → « 1m 8s »)
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Ligne sous la réponse : « ✻ En cours… 12 s · outil » pendant le tour, « ✻ 1 min 8 s · fini à 09:34 » après. */
export function turnLine({ running, elapsedMs, activity = '', endedAt = null }) {
  const d = formatTurnDuration(elapsedMs);
  if (running) return `✻ En cours… ${d}${activity ? ` · ${activity}` : ''}`;
  const at = endedAt instanceof Date && !Number.isNaN(endedAt.getTime())
    ? ` · fini à ${String(endedAt.getHours()).padStart(2, '0')}:${String(endedAt.getMinutes()).padStart(2, '0')}`
    : '';
  return `✻ ${d}${at}`;
}

const BG_WARN_MS = 120_000;

/**
 * Badge des tâches de fond (Bash run_in_background) d'une carte : {text, warn} ou null.
 * `warn` quand la plus ancienne tourne depuis plus de 2 min (longue, ou peut-être bloquée).
 */
export function bgBadge(tasks, now) {
  if (!Array.isArray(tasks) || !tasks.length) return null;
  const oldest = Math.min(...tasks.map((t) => (Number.isFinite(t?.since) ? t.since : now)));
  const age = formatDuration(now - oldest);
  const text = tasks.length === 1
    ? `⏳ tâche de fond${tasks[0]?.label ? ` : ${tasks[0].label}` : ''} · ${age}`
    : `⏳ ${tasks.length} tâches de fond · ${age}`;
  return { text, warn: now - oldest > BG_WARN_MS };
}

/** Nombre de sessions qui attendent l'utilisateur (error exclu). */
export function titleCount(cards) {
  return cards.filter((c) => c.state === 'needs_you').length;
}

export const titleFor = (n) => (n > 0 ? `(${n}) nvim-regie` : 'nvim-regie');

/** Key de la carte needs_you qui suit `current` (une key) dans l'ordre d'affichage, en boucle ; null si aucune. */
export function nextWaiting(cards, current) {
  const sorted = [...cards].sort(byAge);
  const start = sorted.findIndex((c) => c.key === current);
  for (let k = 1; k <= sorted.length; k++) {
    const c = sorted[(start + k + sorted.length) % sorted.length];
    if (c.state === 'needs_you') return c.key;
  }
  return null;
}

/** « il y a 5 min » pour une date passée (mtime en ms) ; `now` injectable pour les tests. */
export function formatAgo(then, now = Date.now()) {
  if (typeof then !== 'number' || Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

/** Clic sur une session passée du sélecteur : 'stay' (c'est celle affichée), 'goto' (ouverte ailleurs), 'resume'. */
export function pastSessionAction(s, currentId) {
  if (!s.open) return 'resume';
  return s.open === currentId ? 'stay' : 'goto';
}
