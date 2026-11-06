import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnOf, groupByColumn, formatDuration, titleCount, titleFor, nextWaiting, COLUMNS, formatAgo,
  formatTurnDuration, turnLine, writersIn, sessionName, pastSessionAction,
} from '../public/dashboard.js';

test('formatTurnDuration : secondes, minutes et secondes, heures', () => {
  assert.equal(formatTurnDuration(11_400), '11 s');
  assert.equal(formatTurnDuration(67_824), '1 min 8 s');
  assert.equal(formatTurnDuration(3_720_000), '1 h 02 min');
  assert.equal(formatTurnDuration(-5), '0 s');
  assert.equal(formatTurnDuration('x'), '');
});

test('turnLine : ligne d\'activité en cours ou de fin de tour', () => {
  assert.equal(turnLine({ running: true, elapsedMs: 12_000, activity: 'Bash : npm test' }), '✻ En cours… 12 s · Bash : npm test');
  assert.equal(turnLine({ running: true, elapsedMs: 3_000, activity: '' }), '✻ En cours… 3 s');
  const end = new Date(2026, 10, 5, 9, 4);
  assert.equal(turnLine({ running: false, elapsedMs: 67_824, endedAt: end }), '✻ 1 min 8 s · fini à 09:04');
});

const card = (project, state, since = 1000) => ({ key: project, project, state, since });

test('quatre colonnes, dans l\'ordre voulu', () => {
  assert.deepEqual(COLUMNS.map((c) => c.id), ['needs_you', 'running', 'done_unread', 'idle']);
});

test('columnOf : chaque état a sa colonne ; error attire l\'attention, stopped est au repos', () => {
  assert.equal(columnOf('needs_you'), 'needs_you');
  assert.equal(columnOf('error'), 'needs_you');
  assert.equal(columnOf('running'), 'running');
  assert.equal(columnOf('done_unread'), 'done_unread');
  assert.equal(columnOf('idle'), 'idle');
  assert.equal(columnOf('stopped'), 'idle');
  assert.equal(columnOf('inconnu'), 'idle');
});

test('groupByColumn : tri par attente décroissante (since le plus ancien d\'abord), égalités par nom', () => {
  const g = groupByColumn([
    card('c', 'needs_you', 3000), card('a', 'needs_you', 1000), card('b', 'needs_you', 1000),
    card('z', 'running', 500), card('y', 'idle', null), card('x', 'stopped', null), card('w', 'idle', 10),
  ]);
  assert.deepEqual(g.needs_you.map((c) => c.project), ['a', 'b', 'c']);
  assert.deepEqual(g.running.map((c) => c.project), ['z']);
  assert.deepEqual(g.done_unread, []);
  assert.deepEqual(g.idle.map((c) => c.project), ['w', 'x', 'y']);
});

test('groupByColumn : ne modifie pas l\'entrée', () => {
  const input = [card('b', 'idle', 2), card('a', 'idle', 1)];
  groupByColumn(input);
  assert.deepEqual(input.map((c) => c.project), ['b', 'a']);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(59_999), '59 s');
  assert.equal(formatDuration(5 * 60_000 + 3_000), '5 min');
  assert.equal(formatDuration(3_600_000 + 5 * 60_000), '1 h 05');
  assert.equal(formatDuration(-5000), '0 s');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(NaN), '');
});

test('titleCount / titleFor : seules les sessions needs_you comptent (pas error)', () => {
  const cards = [card('a', 'needs_you'), card('b', 'needs_you'), card('c', 'error'), card('d', 'running')];
  assert.equal(titleCount(cards), 2);
  assert.equal(titleFor(2), '(2) nvim-regie');
  assert.equal(titleFor(0), 'nvim-regie');
});

test('nextWaiting : prochaine session needs_you après la courante, en boucle ; null si aucune', () => {
  const cards = [card('a', 'needs_you', 1), card('b', 'running', 2), card('c', 'needs_you', 3), card('d', 'error', 4)];
  assert.equal(nextWaiting(cards, null), 'a');
  assert.equal(nextWaiting(cards, 'a'), 'c');
  assert.equal(nextWaiting(cards, 'c'), 'a');
  assert.equal(nextWaiting(cards, 'b'), 'c');
  assert.equal(nextWaiting([card('x', 'idle')], null), null);
  assert.equal(nextWaiting([], 'a'), null);
});

test('formatAgo : « il y a … » pour les sessions passées', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now - 5_000, now), "à l'instant");
  assert.equal(formatAgo(now - 5 * 60_000, now), 'il y a 5 min');
  assert.equal(formatAgo(now - 3 * 3_600_000, now), 'il y a 3 h');
  assert.equal(formatAgo(now - 2 * 86_400_000, now), 'il y a 2 j');
  assert.equal(formatAgo(now + 60_000, now), "à l'instant");
  assert.equal(formatAgo(null, now), '');
  assert.equal(formatAgo(NaN, now), '');
});

const sess = (key, project, state, mode = 'write', since = 1) => ({ key, id: key, project, state, mode, label: '', since });

test('nextWaiting : identifie les cartes par key (deux sessions du même projet)', () => {
  const cards = [sess('s1', 'p', 'needs_you', 'write', 1), sess('s2', 'p', 'needs_you', 'consult', 2)];
  assert.equal(nextWaiting(cards, null), 's1');
  assert.equal(nextWaiting(cards, 's1'), 's2');
  assert.equal(nextWaiting(cards, 's2'), 's1');
});

test('groupByColumn : égalité de since départagée par projet puis key (ordre stable)', () => {
  const g = groupByColumn([sess('b', 'p', 'idle'), sess('a', 'p', 'idle'), sess('c', 'o', 'idle')]);
  assert.deepEqual(g.idle.map((c) => c.key), ['c', 'a', 'b']);
});

test('writersIn : écrivains vivants du projet (ni consultation, ni sortie, ni stopped)', () => {
  const cards = [
    sess('w1', 'p', 'running'), sess('w2', 'p', 'error'), sess('c1', 'p', 'idle', 'consult'),
    sess('w3', 'q', 'idle'), { key: 'p:r', id: null, project: 'r', state: 'stopped', mode: null },
  ];
  assert.equal(writersIn(cards, 'p'), 1);
  assert.equal(writersIn(cards, 'q'), 1);
  assert.equal(writersIn(cards, 'r'), 0);
  assert.equal(writersIn(cards, 'x'), 0);
});

test('sessionName : étiquette, sinon le mode', () => {
  assert.equal(sessionName({ label: 'base', mode: 'write' }), 'base');
  assert.equal(sessionName({ label: '', mode: 'write' }), 'écrivain');
  assert.equal(sessionName({ label: '', mode: 'consult' }), 'lecture');
  assert.equal(sessionName({ label: '', mode: null }), '');
});

test('pastSessionAction : une session passée non ouverte se reprend, même sans session affichée', () => {
  // Régression : open (null) === currentId (null) faisait fermer le sélecteur sans rien lancer.
  assert.equal(pastSessionAction({ open: null }, null), 'resume');
  assert.equal(pastSessionAction({ open: null }, 'aaa'), 'resume');
  assert.equal(pastSessionAction({ open: 'aaa' }, 'aaa'), 'stay');
  assert.equal(pastSessionAction({ open: 'bbb' }, 'aaa'), 'goto');
  assert.equal(pastSessionAction({ open: 'bbb' }, null), 'goto');
});
