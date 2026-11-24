import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRef, resolveInside, resolveInNotes, classify } from '../src/files.js';

// ---------- parseRef : texte cité par l'agent → { rel, line } ou null ----------

test('parseRef : chemin simple, suffixes de ligne :42, :42:7, #L42', () => {
  assert.deepEqual(parseRef('src/app.js'), { rel: 'src/app.js', line: null });
  assert.deepEqual(parseRef('src/app.js:42'), { rel: 'src/app.js', line: 42 });
  assert.deepEqual(parseRef('src/app.js:42:7'), { rel: 'src/app.js', line: 42 });
  assert.deepEqual(parseRef('src/app.js#L42'), { rel: 'src/app.js', line: 42 });
  assert.deepEqual(parseRef('docs\\etape6.md'), { rel: 'docs\\etape6.md', line: null });
  assert.deepEqual(parseRef('README.md'), { rel: 'README.md', line: null }, 'extension sans séparateur');
  assert.deepEqual(parseRef('docs/'), { rel: 'docs/', line: null }, 'dossier avec séparateur final');
  assert.deepEqual(parseRef('./src/a.js'), { rel: './src/a.js', line: null });
  assert.deepEqual(parseRef('  src/a.js  '), { rel: 'src/a.js', line: null }, 'espaces autour retirés');
});

test('parseRef : chemin absolu Windows avec lettre de lecteur accepté (inclusion vérifiée plus tard)', () => {
  assert.deepEqual(parseRef('C:\\x\\a.js:3'), { rel: 'C:\\x\\a.js', line: 3 });
  assert.deepEqual(parseRef('C:/x/a.js'), { rel: 'C:/x/a.js', line: null });
});

test('parseRef : rejette ce qui n\'est pas un chemin sûr', () => {
  for (const bad of [
    '', '   ', 'mot', 'npm test', 'a b/c.js',           // pas un chemin (mot seul, espaces internes)
    '\\\\serveur\\partage\\a.txt', '//serveur/a.txt',   // UNC
    'C:foo.txt',                                        // lecteur relatif
    'src/a.js:flux', 'a.txt:secret:$DATA',              // flux ADS
    'http://x/a.js', 'file:///C:/a.js', 'mailto:a@b.c', // schémas
    'src/a\u0000.js', 'src/a\n.js',                     // NUL, retour ligne
    'x/'.repeat(300) + 'a.js',                          // trop long (> 500)
    null, undefined, 42, {},
  ]) {
    assert.equal(parseRef(bad), null, `refusé : ${JSON.stringify(bad)}`);
  }
});

test('parseRef : ligne nulle ou absurde ignorée', () => {
  assert.equal(parseRef('a/b.js:0').line, null);
  assert.equal(parseRef('a/b.js:99999999999').line, null);
});

// ---------- resolveInside : racine + chemin → absolu (réel) dans la racine, ou null ----------

let tmp, root, outside;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-files-'));
  root = path.join(tmp, 'projet');
  outside = path.join(tmp, 'dehors');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.writeFileSync(path.join(tmp, 'projet-voisin.txt'), 'v');
  // Jonction (pas besoin de droits admin sous Windows) qui pointe hors de la racine.
  fs.symlinkSync(outside, path.join(root, 'fuite'), 'junction');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const real = (p) => fs.realpathSync.native(p);

test('resolveInside : relatif dans la racine → chemin absolu réel', () => {
  assert.equal(resolveInside(root, 'src/a.js'), real(path.join(root, 'src', 'a.js')));
  assert.equal(resolveInside(root, 'src\\a.js'), real(path.join(root, 'src', 'a.js')));
  assert.equal(resolveInside(root, './src/../src/a.js'), real(path.join(root, 'src', 'a.js')));
  assert.equal(resolveInside(root, 'src'), real(path.join(root, 'src')), 'dossier');
  assert.equal(resolveInside(root, 'src/'), real(path.join(root, 'src')), 'dossier, séparateur final');
});

test('resolveInside : absolu dans la racine accepté, casse indifférente sous Windows', () => {
  const abs = path.join(root, 'src', 'a.js');
  assert.equal(resolveInside(root, abs), real(abs));
  if (process.platform === 'win32') assert.equal(resolveInside(root, abs.toUpperCase()), real(abs));
});

test('resolveInside : hors racine, inexistant, jonction sortante, racine elle-même → null', () => {
  assert.equal(resolveInside(root, '../dehors/secret.txt'), null, 'traversée');
  assert.equal(resolveInside(root, path.join(outside, 'secret.txt')), null, 'absolu hors racine');
  assert.equal(resolveInside(root, '../projet-voisin.txt'), null, 'préfixe commun (projet / projet-voisin)');
  assert.equal(resolveInside(root, 'src/absent.js'), null, 'inexistant');
  assert.equal(resolveInside(root, 'fuite/secret.txt'), null, 'jonction vers l\'extérieur');
  assert.equal(resolveInside(root, '.'), null, 'la racine elle-même');
  assert.equal(resolveInside(path.join(tmp, 'pas-de-racine'), 'a.js'), null, 'racine absente');
  assert.equal(resolveInside(root, null), null);
});

// ---------- classify : chemin absolu → catégorie d'action ----------

test('classify : chaque catégorie du tableau', () => {
  const c = (name, isDir = false) => classify(path.join('C:\\x', name), isDir);
  assert.equal(c('src', true), 'dir');
  for (const t of ['a.js', 'a.md', 'a.ps1', 'A.PS1', 'a.bat', 'a.cmd', 'a.sh', 'a.py', 'a.json', 'Makefile', 'a.lua', 'a.txt']) {
    assert.equal(c(t), 'text', t);
  }
  assert.equal(c('a.html'), 'html');
  assert.equal(c('a.htm'), 'html');
  assert.equal(c('a.svg'), 'svg');
  for (const t of ['a.png', 'a.jpg', 'a.JPEG', 'a.gif', 'a.webp', 'a.bmp', 'a.ico']) assert.equal(c(t), 'image', t);
  for (const t of ['a.pdf', 'a.xlsx', 'a.xls', 'a.docx', 'a.doc', 'a.pptx', 'a.csv']) assert.equal(c(t), 'doc', t);
  for (const t of ['a.exe', 'a.dll', 'a.lnk', 'a.zip', 'a.msi', 'a.scr', 'a.com', 'a.url']) assert.equal(c(t), 'other', t);
});

// ---------- resolveInNotes : notes de l'utilisateur, hors du dossier de la session ----------

test('resolveInNotes : « notes_Claude\\… » et absolu sous notesDir → chemin réel ; le reste → null', () => {
  const notes = path.join(tmp, 'OneDrive', 'notes_Claude');
  const note = path.join(notes, 'cad', 'chantiers', 'plan.md');
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, '# note');
  assert.equal(resolveInNotes(notes, 'notes_Claude\\cad\\chantiers\\plan.md'), real(note));
  assert.equal(resolveInNotes(notes, 'notes_Claude/cad/chantiers/plan.md'), real(note));
  assert.equal(resolveInNotes(notes, 'NOTES_CLAUDE\\cad\\chantiers\\plan.md'), process.platform === 'win32' ? real(note) : null);
  assert.equal(resolveInNotes(notes, note), real(note), 'absolu sous notesDir');
  assert.equal(resolveInNotes(notes, 'notes_Claude\\cad'), real(path.join(notes, 'cad')), 'dossier');
  assert.equal(resolveInNotes(notes, 'cad\\chantiers\\plan.md'), null, 'relatif sans le préfixe notes_Claude');
  assert.equal(resolveInNotes(notes, 'notes_Claude\\..\\..\\dehors\\secret.txt'), null, 'traversée');
  assert.equal(resolveInNotes(notes, path.join(outside, 'secret.txt')), null, 'absolu hors notesDir');
  assert.equal(resolveInNotes(notes, 'notes_Claude\\absent.md'), null, 'inexistant');
  assert.equal(resolveInNotes(null, 'notes_Claude\\cad'), null, 'pas de notesDir');
  assert.equal(resolveInNotes('relatif', 'notes_Claude\\cad'), null, 'notesDir non absolu');
});
