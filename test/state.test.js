import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, next, markRead, ptyExited, describeActivity } from '../src/state.js';

const ev = (hook_event_name, extra = {}) => ({ hook_event_name, ...extra });

test('état initial : au repos, sans activité', () => {
  assert.deepEqual(initialState(), { state: 'idle', activity: '' });
});

test('UserPromptSubmit → running', () => {
  assert.equal(next(initialState(), ev('UserPromptSubmit', { prompt: 'x' })).state, 'running');
});

test('PreToolUse → running avec outil + cible', () => {
  const s = next(initialState(), ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'C:\\a\\b.js' } }));
  assert.deepEqual(s, { state: 'running', activity: 'Read C:\\a\\b.js' });
});

test('Notification permission_prompt → needs_you', () => {
  const s = next({ state: 'running', activity: 'Bash ls' }, ev('Notification', { notification_type: 'permission_prompt' }));
  assert.equal(s.state, 'needs_you');
});

test('Notification d\'un autre type : ignorée (même objet)', () => {
  const before = { state: 'running', activity: 'Bash ls' };
  assert.equal(next(before, ev('Notification', { notification_type: 'idle_prompt' })), before);
});

test('needs_you → running dès qu\'un outil se termine ou un autre démarre', () => {
  const w = { state: 'needs_you', activity: 'Bash rm x' };
  assert.equal(next(w, ev('PostToolUse', { tool_name: 'Bash' })).state, 'running');
  assert.equal(next(w, ev('PreToolUse', { tool_name: 'Read', tool_input: {} })).state, 'running');
});

test('PostToolUse en running : inchangé', () => {
  const before = { state: 'running', activity: 'Bash ls' };
  assert.equal(next(before, ev('PostToolUse', { tool_name: 'Bash' })), before);
});

test('Stop → done_unread, activité vidée', () => {
  assert.deepEqual(next({ state: 'running', activity: 'Bash ls' }, ev('Stop')), { state: 'done_unread', activity: '' });
});

test('SessionEnd → idle', () => {
  assert.deepEqual(next({ state: 'running', activity: 'x' }, ev('SessionEnd', { reason: 'other' })), { state: 'idle', activity: '' });
});

test('événement inconnu ou invalide : ignoré, jamais d\'exception', () => {
  const before = { state: 'running', activity: 'x' };
  assert.equal(next(before, ev('Truc')), before);
  assert.equal(next(before, null), before);
  assert.equal(next(before, {}), before);
  assert.equal(next(before, 'Stop'), before);
});

test('mort du pty → error, état collant', () => {
  const e = ptyExited({ state: 'running', activity: 'x' });
  assert.deepEqual(e, { state: 'error', activity: '' });
  assert.equal(next(e, ev('UserPromptSubmit')), e);
  assert.equal(next(e, ev('Stop')), e);
  assert.equal(markRead(e), e);
});

test('markRead : done_unread → idle, les autres états inchangés', () => {
  assert.equal(markRead({ state: 'done_unread', activity: '' }).state, 'idle');
  const r = { state: 'running', activity: 'x' };
  assert.equal(markRead(r), r);
});

test('describeActivity : cible selon l\'outil, tronquée, une seule ligne', () => {
  assert.equal(describeActivity('Bash', { command: 'npm test\nsuite' }), 'Bash npm test');
  assert.equal(describeActivity('Grep', { pattern: 'foo' }), 'Grep foo');
  assert.equal(describeActivity('Glob', { pattern: '**/*.js' }), 'Glob **/*.js');
  assert.equal(describeActivity('Edit', { file_path: 'a.js' }), 'Edit a.js');
  assert.equal(describeActivity('WebFetch', { url: 'https://x' }), 'WebFetch');
  assert.equal(describeActivity('Bash', { command: 'a'.repeat(300) }).length <= 90, true);
  assert.equal(describeActivity(undefined, {}), '');
  assert.equal(describeActivity('Read', null), 'Read');
});

import { interrupted } from '../src/state.js';

test('interrupted : running et needs_you → idle ; les autres états inchangés', () => {
  assert.deepEqual(interrupted({ state: 'running', activity: 'x' }), { state: 'idle', activity: '' });
  assert.equal(interrupted({ state: 'needs_you', activity: 'x' }).state, 'idle');
  for (const st of ['done_unread', 'idle', 'error']) {
    const s = { state: st, activity: '' };
    assert.equal(interrupted(s), s);
  }
});

// ── Tâches de fond ──
import { initialBg, trackBg, afterStop } from '../src/state.js';

const launch = (toolUseId, command) => ({ kind: 'tool_use', role: 'assistant', toolUseId, name: 'Bash', input: { command, run_in_background: true } });
const started = (toolUseId, taskId) => ({ kind: 'tool_result', role: 'user', toolUseId, text: 'running', backgroundTaskId: taskId });
const notif = (taskId, status = 'completed') => ({ kind: 'text', role: 'user', text: '<task-notification>', origin: 'task-notification', taskId, status });
const stop = (taskId) => ({ kind: 'tool_use', role: 'assistant', toolUseId: 't9', name: 'TaskStop', input: { task_id: taskId } });

test('trackBg : lancement puis résultat ouvre une tâche avec la commande comme libellé', () => {
  let bg = trackBg(initialBg(), [launch('t1', 'npm run render\nsuite')], 1000);
  assert.deepEqual(bg.tasks, [], 'pas encore de tâche tant que le résultat n\'a pas donné son id');
  bg = trackBg(bg, [started('t1', 'b1')], 1500);
  assert.deepEqual(bg.tasks, [{ id: 'b1', label: 'npm run render', since: 1500 }]);
});

test('trackBg : lancement et résultat dans deux lots distincts', () => {
  const a = trackBg(initialBg(), [launch('t1', 'sleep 90')], 1);
  const b = trackBg(a, [started('t1', 'b1')], 2);
  assert.equal(b.tasks.length, 1);
});

test('trackBg : un Bash au premier plan n\'ouvre rien', () => {
  const fg = { kind: 'tool_use', role: 'assistant', toolUseId: 't2', name: 'Bash', input: { command: 'ls' } };
  const bg = trackBg(initialBg(), [fg, { kind: 'tool_result', role: 'user', toolUseId: 't2', text: 'ok' }], 1);
  assert.deepEqual(bg.tasks, []);
});

test('trackBg : la notification (completed ou failed) ferme la tâche', () => {
  for (const status of ['completed', 'failed']) {
    let bg = trackBg(initialBg(), [launch('t1', 'x'), started('t1', 'b1')], 1);
    bg = trackBg(bg, [notif('b1', status)], 2);
    assert.deepEqual(bg.tasks, []);
  }
});

test('trackBg : TaskStop ferme la tâche sans notification', () => {
  let bg = trackBg(initialBg(), [launch('t1', 'x'), started('t1', 'b1'), launch('t2', 'y'), started('t2', 'b2')], 1);
  bg = trackBg(bg, [stop('b1')], 2);
  assert.deepEqual(bg.tasks.map((t) => t.id), ['b2']);
});

test('trackBg : id inconnu ignoré, notification en plein lot, jamais d\'exception', () => {
  let bg = trackBg(initialBg(), [notif('zzz')], 1);
  assert.deepEqual(bg.tasks, []);
  bg = trackBg(initialBg(), [launch('t1', 'x'), notif('b1'), started('t1', 'b1')], 1);
  assert.equal(bg.tasks.length, 1, 'une notification arrivée avant son résultat ne ferme rien d\'inconnu');
  assert.doesNotThrow(() => trackBg(bg, [null, 42, { kind: 'text' }], 2));
});

test('trackBg : un texte « notification » sans origin ne ferme rien', () => {
  let bg = trackBg(initialBg(), [launch('t1', 'x'), started('t1', 'b1')], 1);
  bg = trackBg(bg, [{ kind: 'text', role: 'user', text: '<task-notification>', taskId: 'b1', status: 'completed' }], 2);
  assert.equal(bg.tasks.length, 1);
});

test('afterStop : sans tâche de fond → done_unread ; avec → running sans activité', () => {
  const running = { state: 'running', activity: 'Bash x' };
  assert.deepEqual(afterStop(running, initialBg()), { state: 'done_unread', activity: '' });
  const bg = trackBg(initialBg(), [launch('t1', 'x'), started('t1', 'b1')], 1);
  assert.deepEqual(afterStop(running, bg), { state: 'running', activity: '' });
});
