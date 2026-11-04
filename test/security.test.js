import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToken, tokenMatches, parseCookies, originAllowed, hostAllowed } from '../src/security.js';

test('createToken : 64 hex, différent à chaque appel', () => {
  const a = createToken(), b = createToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('tokenMatches : absent, faux, de mauvaise longueur, valide', () => {
  const t = createToken();
  assert.equal(tokenMatches(undefined, t), false);
  assert.equal(tokenMatches('', t), false);
  assert.equal(tokenMatches('abc', t), false);
  assert.equal(tokenMatches(t.replace(/.$/, (c) => (c === '0' ? '1' : '0')), t), false);
  assert.equal(tokenMatches(t, t), true);
});

test('parseCookies : mal formé ne plante pas', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(';;=x; novalue; k=v=w'), { k: 'v=w' });
});

test('originAllowed : exacte uniquement', () => {
  assert.equal(originAllowed(undefined, 47600), false);
  assert.equal(originAllowed('http://evil.example', 47600), false);
  assert.equal(originAllowed('http://127.0.0.1:47601', 47600), false);
  assert.equal(originAllowed('http://localhost:47600', 47600), false);
  assert.equal(originAllowed('http://127.0.0.1:47600', 47600), true);
});

test('hostAllowed : protège contre le DNS rebinding', () => {
  assert.equal(hostAllowed(undefined, 47600), false);
  assert.equal(hostAllowed('evil.example:47600', 47600), false);
  assert.equal(hostAllowed('127.0.0.1:47600', 47600), true);
});
