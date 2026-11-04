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
