import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, validateProject, addProject } from '../src/config.js';

const NVIM = process.execPath; // un chemin absolu qui existe

function tmp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-conf-'));
  const dir = path.join(base, 'projet');
  fs.mkdirSync(dir);
  const file = path.join(base, 'config.json');
  return { base, dir, file };
}

test('validateProject : nom et dossier contrôlés, chemin normalisé', () => {
  const t = tmp();
  assert.deepEqual(validateProject({ name: 'mon projet', path: t.dir }, new Set()), { name: 'mon projet', path: path.resolve(t.dir) });
  assert.throws(() => validateProject({ name: 'é/x', path: t.dir }, new Set()), /name/);
  assert.throws(() => validateProject({ name: 'a', path: 'relatif' }, new Set()), /absolu/);
  assert.throws(() => validateProject({ name: 'a', path: path.join(t.base, 'absent') }, new Set()), /introuvable/);
  assert.throws(() => validateProject({ name: 'a', path: t.dir }, new Set(['a'])), /double/);
  assert.throws(() => validateProject(null, new Set()), /name/);
});

test('validateConfig : accepte toujours une config valide (non-régression du refactor)', () => {
  const t = tmp();
  const c = validateConfig({ projects: [{ name: 'a', path: t.dir }], nvimPath: NVIM });
  assert.equal(c.projects[0].name, 'a');
  assert.equal(c.port, 47600);
});

test('addProject : ajoute dans config.json sans toucher aux autres clés, écriture atomique', () => {
  const t = tmp();
  const autre = path.join(t.base, 'autre');
  fs.mkdirSync(autre);
  const avant = { port: 47601, projects: [{ name: 'a', path: t.dir }], nvimPath: NVIM, sendKey: '<C-CR>', inconnue: { x: [1, 2] } };
  fs.writeFileSync(t.file, JSON.stringify(avant, null, 2));
  const p = addProject(t.file, { name: 'b', path: autre });
  assert.deepEqual(p, { name: 'b', path: path.resolve(autre) });
  const apres = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  assert.deepEqual(apres.projects, [{ name: 'a', path: t.dir }, { name: 'b', path: path.resolve(autre) }]);
  assert.deepEqual({ ...apres, projects: null }, { ...avant, projects: null }, 'autres clés intactes');
  assert.deepEqual(fs.readdirSync(t.base).sort(), ['autre', 'config.json', 'projet'], 'aucun fichier temporaire laissé');
});

test('addProject : doublon (nom ou dossier), dossier invalide, fichier illisible → refus, fichier inchangé', () => {
  const t = tmp();
  const autre = path.join(t.base, 'autre');
  fs.mkdirSync(autre);
  const texte = JSON.stringify({ projects: [{ name: 'a', path: t.dir }], nvimPath: NVIM });
  fs.writeFileSync(t.file, texte);
  assert.throws(() => addProject(t.file, { name: 'a', path: autre }), /double/);
  assert.throws(() => addProject(t.file, { name: 'b', path: t.dir.toUpperCase() }), /déjà suivi/);
  assert.throws(() => addProject(t.file, { name: 'b', path: path.join(t.base, 'absent') }), /introuvable/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), texte);
  fs.writeFileSync(t.file, '{pas du json');
  assert.throws(() => addProject(t.file, { name: 'b', path: autre }), /illisible/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{pas du json');
});
