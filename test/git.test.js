import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBranch } from '../src/git.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regie-git-'));

test('branche normale, y compris avec un « / »', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/feat/tableau\n');
  assert.equal(readBranch(d), 'feat/tableau');
});

test('HEAD détaché : hash court', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(readBranch(d), '0123456');
});

test('worktree : .git est un fichier « gitdir: … » (absolu ou relatif)', () => {
  const main = tmp();
  const wt = path.join(main, '.git', 'worktrees', 'w1');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'HEAD'), 'ref: refs/heads/wt-branche\n');
  const abs = tmp();
  fs.writeFileSync(path.join(abs, '.git'), `gitdir: ${wt}\n`);
  assert.equal(readBranch(abs), 'wt-branche');
  const rel = path.join(main, 'sous');
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(rel, '.git'), `gitdir: ${path.relative(rel, wt)}\n`);
  assert.equal(readBranch(rel), 'wt-branche');
});

test('pas de dépôt, fichier absent ou contenu illisible : null, jamais d\'exception', () => {
  const d = tmp();
  assert.equal(readBranch(d), null);
  fs.mkdirSync(path.join(d, '.git'));
  assert.equal(readBranch(d), null);
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'n\'importe quoi\n');
  assert.equal(readBranch(d), null);
  assert.equal(readBranch(path.join(d, 'inexistant')), null);
  assert.equal(readBranch(undefined), null);
  assert.equal(readBranch(42), null);
});

test('nom de branche borné à une ligne de longueur raisonnable', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), `ref: refs/heads/${'x'.repeat(500)}\n`);
  assert.ok(readBranch(d).length <= 100);
});
