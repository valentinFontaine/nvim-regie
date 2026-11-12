// Machine à états d'une session, alimentée par les hooks de Claude Code. Fonctions pures :
// un « instantané » {state, activity} entre, un nouvel instantané sort (le même objet si rien ne change).

import { detachedTarget } from './detached.js';

export const STATES =['running', 'needs_you', 'done_unread', 'idle', 'error'];

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

// ── Tâches de fond (Bash run_in_background) ──
// Le tour de claude se termine (Stop) pendant que la tâche tourne : sans ce suivi, la carte dirait « au repos ».
// Sources, toutes dans le transcript : tool_use (commande) → tool_result (backgroundTaskId) → notification
// de fin (origin « task-notification ») ou TaskStop (qui ne produit aucune notification).

const MAX_LAUNCHES = 50;

export function initialBg() {
  return { launch: {}, tasks: [] };
}

/** Nouvel état des tâches de fond après un lot d'items du transcript (fonction pure). */
export function trackBg(bg, items, now = Date.now()) {
  let launch = bg.launch;
  let tasks = bg.tasks;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    if (it.kind === 'tool_use' && it.name === 'Bash' && it.input?.run_in_background === true && typeof it.toolUseId === 'string') {
      const label = oneLine(it.input.command).slice(0, MAX_ACTIVITY) || 'Bash';
      launch = { ...launch, [it.toolUseId]: label };
      const keys = Object.keys(launch);
      if (keys.length > MAX_LAUNCHES) launch = Object.fromEntries(keys.slice(-MAX_LAUNCHES).map((k) => [k, launch[k]]));
    } else if (it.kind === 'tool_use' && it.name === 'Bash' && typeof it.toolUseId === 'string' && detachedTarget(it.input?.command)) {
      // Lancement détaché dans un Bash ordinaire (nohup … &) : la tâche s'ouvre au résultat, la sonde de processus la ferme.
      launch = { ...launch, [it.toolUseId]: { target: detachedTarget(it.input.command) } };
    } else if (it.kind === 'tool_result' && !it.backgroundTaskId && launch[it.toolUseId]?.target) {
      const { [it.toolUseId]: d, ...rest } = launch;
      launch = rest;
      tasks = [...tasks, { id: `d:${it.toolUseId}`, label: d.target, target: d.target, detached: true, since: now }];
    } else if (it.kind === 'proc-end' && typeof it.id === 'string') {
      tasks = tasks.filter((t) => t.id !== it.id);
    } else if (it.kind === 'tool_result' && it.backgroundTaskId && typeof launch[it.toolUseId] === 'string') {
      const { [it.toolUseId]: label, ...rest } = launch;
      launch = rest;
      tasks = [...tasks.filter((t) => t.id !== it.backgroundTaskId), { id: it.backgroundTaskId, label, since: now }];
    } else if (it.kind === 'text' && it.role === 'user' && it.origin === 'task-notification' && it.taskId) {
      tasks = tasks.filter((t) => t.id !== it.taskId);
    } else if (it.kind === 'tool_use' && it.name === 'TaskStop' && typeof it.input?.task_id === 'string') {
      tasks = tasks.filter((t) => t.id !== it.input.task_id);
    }
  }
  return launch === bg.launch && tasks === bg.tasks ? bg : { launch, tasks };
}

/** Fin de tour : « terminé » seulement si aucune tâche de fond n'est ouverte, sinon la session travaille encore. */
export function afterStop(snap, bg) {
  if (snap.state === 'error') return snap;
  return bg.tasks.length ? { state: 'running', activity: '' } : { state: 'done_unread', activity: '' };
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
