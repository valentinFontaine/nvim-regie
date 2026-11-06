import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeProjectDir, findTranscript, parseLine, toItems, TranscriptTail,
} from '../src/transcript.js';

test('toItems : fin de tour (system/turn_duration) → item turn', () => {
  const e = { type: 'system', subtype: 'turn_duration', durationMs: 67824, timestamp: '2026-11-05T08:34:23.726Z', uuid: 'u-1', isMeta: false };
  assert.deepEqual(toItems(e), [{ msgId: 'u-1', role: 'system', ts: '2026-11-05T08:34:23.726Z', kind: 'turn', durationMs: 67824 }]);
  assert.deepEqual(toItems({ ...e, durationMs: 'x' }), [], 'durée invalide ignorée');
  assert.deepEqual(toItems({ ...e, isSidechain: true }), [], 'sous-agent ignoré');
  assert.deepEqual(toItems({ ...e, subtype: 'stop_hook_summary' }), [], 'autres system ignorés');
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'session.jsonl');
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await wait(20); }
  assert.fail('délai dépassé');
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'regie-')); }

function itemsOfFixture() {
  return fs.readFileSync(FIXTURE, 'utf8').split('\n').map(parseLine).filter(Boolean).flatMap(toItems);
}

test('parseLine : invalide, vide, non-objet → null', () => {
  assert.equal(parseLine('{pas du json'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('42'), null);
  assert.equal(parseLine('null'), null);
  assert.deepEqual(parseLine('{"a":1}'), { a: 1 });
});

test('toItems : types inconnus, isMeta et sidechain ignorés', () => {
  assert.deepEqual(toItems({ type: 'api-request' }), []);
  assert.deepEqual(toItems({ type: 'system', subtype: 'turn_duration' }), []);
  assert.deepEqual(toItems({ type: 'user', isMeta: true, message: { content: 'x' } }), []);
  assert.deepEqual(toItems({ type: 'assistant', isSidechain: true, message: { id: 'm', content: [{ type: 'text', text: 'x' }] } }), []);
  assert.deepEqual(toItems({ type: 'user' }), []);
  assert.deepEqual(toItems({ type: 'assistant', message: { content: 42 } }), []);
});

test('fixture : séquence d\'items attendue', () => {
  const it = itemsOfFixture();
  assert.deepEqual(it.map((i) => `${i.role}:${i.kind}`), [
    'user:text',            // chaîne
    'assistant:text',       // thinking vide écarté
    'assistant:tool_use',
    'user:tool_result',
    'assistant:thinking',
    'assistant:text',
    'user:tool_result',
    'user:text',            // bloc text
    'system:turn',          // fin de tour (turn_duration)
  ]);
  assert.equal(it[0].text, 'Bonjour **toi**');
  assert.equal(it[0].msgId, 'u1');
});

test('un message assistant en plusieurs lignes partage le même msgId', () => {
  const it = itemsOfFixture();
  const m1 = it.filter((i) => i.role === 'assistant' && i.msgId === 'm1');
  assert.deepEqual(m1.map((i) => i.kind), ['text', 'tool_use']);
  const tu = m1[1];
  assert.equal(tu.toolUseId, 't1');
  assert.equal(tu.name, 'Read');
  assert.deepEqual(tu.input, { file_path: 'a.txt' });
  assert.equal(it.find((i) => i.kind === 'tool_result').toolUseId, 't1');
});

test('tool_result : chaîne, blocs avec image, erreur', () => {
  const trs = itemsOfFixture().filter((i) => i.kind === 'tool_result');
  assert.equal(trs[0].text, 'contenu du fichier');
  assert.equal(trs[0].isError, false);
  assert.equal(trs[1].toolUseId, 't2');
  assert.equal(trs[1].isError, true);
  assert.equal(trs[1].text, 'boom\n[image]');
});

test('tool_result trop long tronqué ; entrée d\'outil bornée', () => {
  const big = 'x'.repeat(50_000);
  const [r] = toItems({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } });
  assert.ok(r.text.length < 21_000);
  assert.match(r.text, /tronqué/);
  const [u] = toItems({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: big, n: 3 } }] } });
  assert.ok(u.input.content.length < 5_000);
  assert.equal(u.input.n, 3);
});

test('encodeProjectDir : tout caractère hors [A-Za-z0-9] devient -', () => {
  assert.equal(
    encodeProjectDir('C:\\Users\\irpaui\\Documents\\Projets\\perso\\nvim-regie'),
    'C--Users-irpaui-Documents-Projets-perso-nvim-regie',
  );
  assert.equal(encodeProjectDir('C:\\a\\MOLE\\.claude\\w'), 'C--a-MOLE--claude-w');
  assert.equal(encodeProjectDir('C:\\a_b\\é'), 'C--a-b--');
});

test('findTranscript : UUID invalide refusé, dossier encodé puis repli par recherche', () => {
  const root = tmpdir();
  assert.throws(() => findTranscript(root, 'C:\\p', '../../etc/passwd'));
  assert.throws(() => findTranscript(root, 'C:\\p', 'pas-un-uuid'));
  assert.equal(findTranscript(root, 'C:\\p', UUID), null);

  const enc = path.join(root, encodeProjectDir('C:\\p'));
  fs.mkdirSync(enc);
  fs.writeFileSync(path.join(enc, `${UUID}.jsonl`), '');
  assert.equal(findTranscript(root, 'C:\\p', UUID), path.join(enc, `${UUID}.jsonl`));

  // encodage divergent : le filet de sécurité trouve le fichier ailleurs
  const other = path.join(root, 'autre-nom');
  fs.mkdirSync(other);
  const UUID2 = '123e4567-e89b-42d3-a456-426614174001';
  fs.writeFileSync(path.join(other, `${UUID2}.jsonl`), '');
  assert.equal(findTranscript(root, 'C:\\p', UUID2), path.join(other, `${UUID2}.jsonl`));
});

test('TranscriptTail : fichier absent puis créé, lignes coupées, troncature', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 's.jsonl');
  const batches = [];
  const tail = new TranscriptTail({ resolve: () => (fs.existsSync(file) ? file : null), onItems: (b) => batches.push(...b), intervalMs: 20 });
  tail.start();
  await wait(80);
  assert.equal(batches.length, 0);

  const l1 = JSON.stringify({ type: 'user', uuid: 'a', message: { content: 'un' } }) + '\n';
  const l2 = JSON.stringify({ type: 'user', uuid: 'b', message: { content: 'deux' } }) + '\n';
  fs.writeFileSync(file, l1 + l2.slice(0, 10));
  await until(() => batches.length === 1);
  assert.equal(batches[0].text, 'un');

  fs.appendFileSync(file, l2.slice(10));
  await until(() => batches.length === 2);
  assert.equal(batches[1].text, 'deux');

  // troncature : on repart du début, sans planter
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'c', message: { content: 'trois' } }) + '\n');
  await until(() => batches.some((b) => b.text === 'trois'));
  tail.stop();
});

test('tolérance sur de vrais transcripts locaux (sauté si absents)', { skip: !fs.existsSync(path.join(os.homedir(), '.claude', 'projects')) }, () => {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let files = 0;
  for (const d of fs.readdirSync(root).slice(0, 15)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).slice(0, 2)) {
      const size = fs.statSync(path.join(dir, f)).size;
      if (size > 20_000_000) continue;
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const o = parseLine(l);
        if (o) toItems(o); // ne doit jamais lever
      }
      files++;
    }
  }
  assert.ok(files >= 0);
});

test('acceptTranscript : seulement <racine>/<dossier>/<uuid>.jsonl', async () => {
  const { acceptTranscript } = await import('../src/transcript.js');
  const path = await import('node:path');
  const root = path.resolve('C:/r/projects');
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(acceptTranscript(root, path.join(root, 'proj-x', `${id}.jsonl`)), path.join(root, 'proj-x', `${id}.jsonl`));
  for (const bad of [
    path.join(root, '..', 'autre', `${id}.jsonl`), path.join(root, `${id}.jsonl`),
    path.join(root, 'a', 'b', `${id}.jsonl`), path.join(root, 'proj-x', `${id}.txt`),
    path.join(root, 'proj-x', 'notuuid.jsonl'), 'relatif/x.jsonl', null, 42,
  ]) assert.equal(acceptTranscript(root, bad), null, String(bad));
});

test('TranscriptTail.kick : relecture immédiate puis rapide, sans attendre l\'intervalle normal', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'k.jsonl');
  fs.writeFileSync(file, '');
  const batches = [];
  const tail = new TranscriptTail({ resolve: () => file, onItems: (b) => batches.push(...b), intervalMs: 60_000 });
  tail.start();
  tail.kick(2000);
  await wait(50);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'vite' } }) + '\n');
  const t = Date.now();
  while (!batches.length && Date.now() - t < 1000) await wait(10);
  tail.stop();
  assert.equal(batches[0]?.text, 'vite', 'ligne lue en mode rapide');
  assert.ok(Date.now() - t < 500, 'lue en moins de 500 ms');
});
