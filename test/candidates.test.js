import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCandidates, suggestName } from '../src/candidates.js';

/** Arbre temporaire : dossiers réels + faux ~/.claude.json dont les clés sont écrites avec des « / » comme claude. */
function setup(dirs, extraKeys = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-cand-'));
  for (const d of dirs) fs.mkdirSync(path.join(base, d), { recursive: true });
  const slash = (p) => p.replaceAll('\\', '/');
  const keys = [...dirs.map((d) => slash(path.join(base, d))), ...extraKeys.map((k) => (path.isAbsolute(k) ? k : slash(path.join(base, k))))];
  const claudeJson = path.join(base, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, projects: Object.fromEntries(keys.map((k) => [k, { x: 1 }])) }));
  return { base, claudeJson, p: (d) => path.join(base, d) };
}

test('listCandidates : chemins normalisés (antislash), triés par nom, avec un nom proposé', () => {
  const t = setup(['zeta', 'Alpha']);
  const r = listCandidates({ claudeJson: t.claudeJson, tracked: [], excludeRoots: [] });
  assert.deepEqual(r, [{ path: t.p('Alpha'), name: 'Alpha' }, { path: t.p('zeta'), name: 'zeta' }]);
});

test('listCandidates : écarte chemins disparus, fichiers, worktrees, dossiers sous excludeRoots', () => {
  const t = setup(['ok', 'tmp/scratch', 'ok/.claude/worktrees/chant', 'ok2'], ['disparu']);
  fs.writeFileSync(path.join(t.base, 'fichier.txt'), 'x');
  const raw = JSON.parse(fs.readFileSync(t.claudeJson, 'utf8'));
  raw.projects[`${t.base.replaceAll('\\', '/')}/fichier.txt`] = {};
  fs.writeFileSync(t.claudeJson, JSON.stringify(raw));
  const r = listCandidates({ claudeJson: t.claudeJson, tracked: [], excludeRoots: [t.p('tmp')] });
  assert.deepEqual(r.map((c) => c.path), [t.p('ok'), t.p('ok2')]);
});

test('listCandidates : écarte les dossiers déjà suivis (casse et séparateurs ignorés)', () => {
  const t = setup(['a', 'b']);
  const r = listCandidates({
    claudeJson: t.claudeJson,
    tracked: [{ name: 'A', path: t.p('a').toUpperCase().replace(/\\/g, '/') }],
    excludeRoots: [],
  });
  assert.deepEqual(r.map((c) => c.path), [t.p('b')]);
});

test('listCandidates : nom proposé unique parmi les projets suivis et les autres candidats', () => {
  const t = setup(['x/app', 'y/app']);
  const r = listCandidates({ claudeJson: t.claudeJson, tracked: [{ name: 'app 2', path: path.join(t.base, 'ailleurs') }], excludeRoots: [] });
  assert.deepEqual(r.map((c) => c.name), ['app', 'app 3']);
});

test('listCandidates : ~/.claude.json absent, illisible ou sans « projects » → liste vide, jamais d\'exception', () => {
  const t = setup([]);
  assert.deepEqual(listCandidates({ claudeJson: path.join(t.base, 'absent.json'), tracked: [] }), []);
  fs.writeFileSync(t.claudeJson, '{pas du json');
  assert.deepEqual(listCandidates({ claudeJson: t.claudeJson, tracked: [] }), []);
  fs.writeFileSync(t.claudeJson, JSON.stringify({ projects: [1, 2] }));
  assert.deepEqual(listCandidates({ claudeJson: t.claudeJson, tracked: [] }), []);
  fs.writeFileSync(t.claudeJson, JSON.stringify({ projects: { 'relatif/chemin': {} } }));
  assert.deepEqual(listCandidates({ claudeJson: t.claudeJson, tracked: [] }), [], 'chemin non absolu ignoré');
});

test('suggestName : respecte /^[\\w .-]{1,64}$/ (caractères interdits remplacés, longueur plafonnée)', () => {
  assert.equal(suggestName('C:\\Projets\\mon app', new Set()), 'mon app');
  assert.equal(suggestName('C:\\Projets\\Café#1', new Set()), 'Caf-1', 'suite de caractères interdits → un seul tiret');
  assert.match(suggestName(`C:\\P\\${'x'.repeat(100)}`, new Set()), /^[\w .-]{1,64}$/);
  assert.equal(suggestName('C:\\P\\app', new Set(['app', 'app 2'])), 'app 3');
  assert.match(suggestName('C:\\', new Set()), /^[\w .-]{1,64}$/, 'racine : nom de repli');
});
