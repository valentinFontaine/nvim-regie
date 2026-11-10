import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteFile, readNote, noteExcerpt } from '../src/notes.js';

/** notesDir temporaire avec <projet>\chantiers\<fichier>. */
function notes(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-notes-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return dir;
}

const projet = path.join(os.tmpdir(), 'dossiers', 'demo');

test('noteFile : <notesDir>\\<dossier du projet>\\chantiers\\<branche>.md, « / » devient « - »', () => {
  const d = path.resolve('/n');
  assert.equal(noteFile(d, projet, 'essai'), path.join(d, 'demo', 'chantiers', 'essai.md'));
  assert.equal(noteFile(d, projet, 'feat/essai'), path.join(d, 'demo', 'chantiers', 'feat-essai.md'));
});

test('noteFile : branche ou projet douteux → null (jamais de traversée de chemin)', () => {
  const d = path.resolve('/n');
  for (const bad of ['', '..', '../x', 'a/../b', 'a\\b', 'a b', '.', null, undefined, 42, 'x'.repeat(101)]) {
    assert.equal(noteFile(d, projet, bad), null, String(bad));
  }
  assert.equal(noteFile(d, path.parse(projet).root, 'essai'), null, 'projet sans nom de dossier');
  assert.equal(noteFile('', projet, 'essai'), null, 'notesDir absent');
  assert.equal(noteFile('relatif', projet, 'essai'), null, 'notesDir non absolu');
});

test('readNote : lit la note du chantier, null si absente, illisible ou trop grosse', () => {
  const d = notes({ 'demo/chantiers/essai.md': '**Objectif** : x\n', 'demo/chantiers/gros.md': 'a'.repeat(200 * 1024) });
  assert.equal(readNote(d, projet, 'essai'), '**Objectif** : x\n');
  assert.equal(readNote(d, projet, 'absente'), null);
  assert.equal(readNote(d, projet, '../essai'), null);
  assert.equal(readNote(d, projet, 'gros'), null, 'plafond de taille');
  assert.equal(readNote(path.join(d, 'nexiste-pas'), projet, 'essai'), null);
});

test('noteExcerpt : Objectif et Prochaine commande du gabarit, sinon début de la note', () => {
  const t = '# Titre\n**Objectif** : faire X\n**Fait** : a\n**Reste** : b\n**Prochaine commande** : /clear puis Y\n';
  assert.equal(noteExcerpt(t), 'Objectif : faire X\nProchaine commande : /clear puis Y');
  assert.equal(noteExcerpt('juste du texte\nsur deux lignes'), 'juste du texte\nsur deux lignes');
  assert.equal(noteExcerpt('a'.repeat(1000)).length, 300, 'extrait plafonné');
  assert.equal(noteExcerpt(''), '');
  assert.equal(noteExcerpt(null), '');
});
