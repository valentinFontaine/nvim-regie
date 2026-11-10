import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  cleanChantierName, chantierPath, listChantiers, createChantier, removeChantier,
} from '../src/chantiers.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/** Dépôt temporaire sur `main` avec un commit : le dossier principal d'un projet. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-chantier-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return { name: 'demo', path: dir };
}

test('cleanChantierName : minuscules, chiffres, tirets internes, 40 caractères au plus', () => {
  for (const ok of ['essai', 'etape7b-worktrees', 'a', 'x1-2-3', 'a'.repeat(40)]) {
    assert.equal(cleanChantierName(ok), ok);
  }
  assert.equal(cleanChantierName('  essai  '), 'essai', 'espaces autour retirés');
  for (const bad of [
    '', ' ', '..', 'a/b', 'a\\b', 'Main', 'Essai', '-x', 'x-', 'a--b', 'a b', 'a.b', 'a_b', 'é',
    'a'.repeat(41), 'main', 'master', 'head', undefined, null, 42, {},
  ]) {
    assert.throws(() => cleanChantierName(bad), TypeError, String(bad));
  }
});

test('chantierPath : <projet>/.claude/worktrees/<nom>, nom revalidé', () => {
  const p = { name: 'demo', path: path.resolve('/tmp/projet') };
  assert.equal(chantierPath(p, 'essai'), path.join(p.path, '.claude', 'worktrees', 'essai'));
  assert.throws(() => chantierPath(p, '../x'), TypeError);
});

test('listChantiers : vide sans dossier de worktrees, jamais d\'exception', () => {
  const p = repo();
  assert.deepEqual(listChantiers(p), []);
  assert.deepEqual(listChantiers({ name: 'x', path: path.join(p.path, 'inexistant') }), []);
  // Un dossier sans fichier .git n'est pas un chantier.
  fs.mkdirSync(path.join(p.path, '.claude', 'worktrees', 'faux'), { recursive: true });
  assert.deepEqual(listChantiers(p), []);
});

test('createChantier : worktree sur la branche du même nom, listé, dépôt principal propre', async () => {
  const p = repo();
  const c = await createChantier(p, 'essai');
  assert.deepEqual(c, { name: 'essai', path: chantierPath(p, 'essai'), branch: 'essai' });
  assert.ok(fs.existsSync(path.join(c.path, 'a.txt')), 'le worktree contient les fichiers de HEAD');
  assert.deepEqual(listChantiers(p), [c]);
  assert.equal(git(p.path, 'status', '--porcelain'), '', '.claude/worktrees exclu : git status propre');
  await createChantier(p, 'autre');
  assert.deepEqual(listChantiers(p).map((x) => x.name), ['autre', 'essai']);
  const exclude = fs.readFileSync(path.join(p.path, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/).filter((l) => l.trim() === '.claude/worktrees/').length, 1, 'ligne ajoutée une seule fois');
});

test('createChantier : nom invalide, chantier existant ou branche existante refusés', async () => {
  const p = repo();
  await assert.rejects(createChantier(p, '../x'), TypeError);
  await createChantier(p, 'essai');
  await assert.rejects(createChantier(p, 'essai'));
  git(p.path, 'branch', 'prise');
  await assert.rejects(createChantier(p, 'prise'));
  assert.deepEqual(listChantiers(p).map((x) => x.name), ['essai']);
});

test('removeChantier : refusé si session vivante, fichier modifié ou non suivi, branche non fusionnée', async () => {
  const p = repo();
  const c = await createChantier(p, 'essai');
  await assert.rejects(removeChantier(p, 'essai', { hasLiveSession: true }), /session/i);

  fs.writeFileSync(path.join(c.path, 'nouveau.txt'), 'n\n');
  await assert.rejects(removeChantier(p, 'essai'), /modifi|propre/i);
  git(c.path, 'add', 'nouveau.txt');
  git(c.path, 'commit', '-q', '-m', 'travail');
  await assert.rejects(removeChantier(p, 'essai'), /fusionn/i);

  assert.deepEqual(listChantiers(p).map((x) => x.name), ['essai'], 'rien n\'a été retiré');
  assert.match(git(p.path, 'branch', '--list', 'essai'), /essai/);
});

test('removeChantier : après fusion, worktree et branche disparaissent', async () => {
  const p = repo();
  const c = await createChantier(p, 'essai');
  fs.writeFileSync(path.join(c.path, 'b.txt'), 'b\n');
  git(c.path, 'add', 'b.txt');
  git(c.path, 'commit', '-q', '-m', 'b');
  git(p.path, 'merge', '-q', '--ff-only', 'essai');
  await removeChantier(p, 'essai');
  assert.deepEqual(listChantiers(p), []);
  assert.equal(fs.existsSync(c.path), false);
  assert.equal(git(p.path, 'branch', '--list', 'essai'), '');
});

// Vu sur l'essai manuel du 2026-11-10 : un terminal resté dans le worktree verrouille le dossier
// (Windows). `git worktree remove` vide et désenregistre le worktree, puis échoue sur le dossier :
// la branche restait et la régie ne voyait plus le chantier. Attendu : clôture menée à son terme,
// dossier vide restant signalé.
test('removeChantier : dossier verrouillé par un autre programme → branche supprimée, reste signalé',
  { skip: process.platform !== 'win32' && 'verrou de dossier courant propre à Windows' }, async () => {
    const p = repo();
    const c = await createChantier(p, 'essai');
    fs.writeFileSync(path.join(c.path, 'b.txt'), 'b\n');
    git(c.path, 'add', 'b.txt');
    git(c.path, 'commit', '-q', '-m', 'b');
    git(p.path, 'merge', '-q', '--ff-only', 'essai');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: c.path, stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      const res = await removeChantier(p, 'essai');
      assert.equal(res?.leftover, c.path);
      assert.equal(git(p.path, 'branch', '--list', 'essai'), '');
      assert.ok(!git(p.path, 'worktree', 'list', '--porcelain').includes('essai'));
      assert.deepEqual(listChantiers(p), []);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  });

test('removeChantier : chantier inconnu ou nom invalide refusés', async () => {
  const p = repo();
  await assert.rejects(removeChantier(p, 'absent'));
  await assert.rejects(removeChantier(p, '../x'), TypeError);
});
