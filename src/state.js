// Machine à états d'une session, alimentée par les hooks de Claude Code. Fonctions pures :
// un « instantané » {state, activity} entre, un nouvel instantané sort (le même objet si rien ne change).

export const STATES = ['running', 'needs_you', 'done_unread', 'idle', 'error'];

const MAX_ACTIVITY = 80;

export function initialState() {
  return { state: 'idle', activity: '' };
}

const oneLine = (v) => String(v ?? '').split(/\r?\n/, 1)[0].trim();

/** « Outil + cible » affichés sur la carte : Bash → commande, Read/Edit/Write → fichier, Grep/Glob → motif. */
export function describeActivity(tool, input) {
  if (typeof tool !== 'string' || !tool) return '';
  const i = input && typeof input === 'object' ? input : {};
  let target = '';
  if (tool === 'Bash') target = i.command;
  else if (tool === 'Grep' || tool === 'Glob') target = i.pattern;
  else if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) target = i.file_path ?? i.notebook_path;
  const t = oneLine(typeof target === 'string' ? target : '').slice(0, MAX_ACTIVITY);
  return t ? `${tool} ${t}` : tool;
}

/** Applique un événement de hook (corps JSON reçu). Inconnu ou invalide : ignoré. */
export function next(snap, event) {
  if (snap.state === 'error') return snap;
  if (!event || typeof event !== 'object') return snap;
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      return { state: 'running', activity: '' };
    case 'PreToolUse':
      return { state: 'running', activity: describeActivity(event.tool_name, event.tool_input) };
    case 'PostToolUse':
      return snap.state === 'needs_you' ? { state: 'running', activity: snap.activity } : snap;
    case 'Notification':
      return event.notification_type === 'permission_prompt'
        ? { state: 'needs_you', activity: snap.activity }
        : snap;
    case 'Stop':
      return { state: 'done_unread', activity: '' };
    case 'SessionEnd':
      return { state: 'idle', activity: '' };
    default:
      return snap;
  }
}

/** Le pty de `claude` est mort. */
export function ptyExited() {
  return { state: 'error', activity: '' };
}

/** L'utilisateur ouvre la session : « terminé, non lu » devient « au repos ». */
export function markRead(snap) {
  return snap.state === 'done_unread' ? { state: 'idle', activity: '' } : snap;
}

/** Esc en plein tour : aucun hook ne part, c'est le transcript qui le dit. Seuls running/needs_you sont concernés. */
export function interrupted(snap) {
  return snap.state === 'running' || snap.state === 'needs_you' ? { state: 'idle', activity: '' } : snap;
}

/** Ligne écrite par claude dans le JSONL quand l'utilisateur interrompt (vérifié sur 2.1.318). */
export function isInterruptItem(item) {
  return !!item && item.kind === 'text' && item.role === 'user'
    && typeof item.text === 'string' && item.text.startsWith('[Request interrupted by user');
}
