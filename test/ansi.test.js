import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ansiSegments } from '../public/ansi.js';

test('texte sans séquence : un seul segment sans couleur', () => {
  assert.deepEqual(ansiSegments('12k/200k'), [{ text: '12k/200k', color: null, bold: false }]);
});

test('couleurs 31, 38;5;208, reset ; séquences inconnues retirées', () => {
  const segs = ansiSegments('a\x1b[31mrouge\x1b[0m b \x1b[38;5;208morange\x1b[0m\x1b[2Kc');
  assert.deepEqual(segs.map((s) => s.text), ['a', 'rouge', ' b ', 'orange', 'c']);
  assert.equal(segs[0].color, null);
  assert.equal(segs[1].color, '#cd3131');
  assert.equal(segs[3].color, '#ff8700');
  assert.equal(segs[4].color, null);
});

test('gras et 24 bits', () => {
  const [s] = ansiSegments('\x1b[1;38;2;10;20;30mX');
  assert.deepEqual(s, { text: 'X', color: 'rgb(10,20,30)', bold: true });
});
