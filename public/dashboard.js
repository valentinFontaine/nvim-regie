// Logique pure du tableau de bord (aucun DOM) : colonnes, tri, durées, compteur du titre.

export const COLUMNS = [
  { id: 'needs_you', label: 'Besoin de toi' },
  { id: 'running', label: 'En cours' },
  { id: 'done_unread', label: 'Terminé, non lu' },
  { id: 'idle', label: 'Au repos' },
];

/** Colonne d'une carte. `error` attire l'attention ; `stopped` (non lancé) et inconnu sont au repos. */
export function columnOf(state) {
  if (state === 'needs_you' || state === 'error') return 'needs_you';
  if (state === 'running' || state === 'done_unread') return state;
  return 'idle';
}

// Depuis le plus ancien `since` (attente la plus longue) ; sans `since` en dernier ; égalités par nom.
const byAge = (a, b) => {
  const x = a.since ?? Infinity;
  const y = b.since ?? Infinity;
  if (x !== y) return x < y ? -1 : 1;
  return String(a.project).localeCompare(String(b.project));
};

export function groupByColumn(cards) {
  const g = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const c of cards) g[columnOf(c.state)].push(c);
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

/** Nombre de sessions qui attendent l'utilisateur (error exclu). */
export function titleCount(cards) {
  return cards.filter((c) => c.state === 'needs_you').length;
}

export const titleFor = (n) => (n > 0 ? `(${n}) nvim-regie` : 'nvim-regie');

/** Projet needs_you qui suit `current` dans l'ordre d'affichage, en boucle ; null si aucun. */
export function nextWaiting(cards, current) {
  const sorted = [...cards].sort(byAge);
  const start = sorted.findIndex((c) => c.project === current);
  for (let k = 1; k <= sorted.length; k++) {
    const c = sorted[(start + k + sorted.length) % sorted.length];
    if (c.state === 'needs_you') return c.project;
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
