import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPastSessions, scanCount } from '../src/sessions-list.js';
import { encodeProjectDir } from '../src/transcript.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

const user = (text) => JSON.stringify({ type: 'user', uuid: 'u' + Math.random(), message: { role: 'user', content: text } });
const asst = (text) => JSON.stringify({ type: 'assistant', uuid: 'a' + Math.random(), message: { id: 'm' + Math.random(), role: 'assistant', content: [{ type: 'text', text }] } });
const title = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-sl-'));
  const projectPath = path.join(root, 'proj');
  const dir = path.join(root, encodeProjectDir(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const put = (id, lines, when) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    if (when) fs.utimesSync(f, new Date(when), new Date(when));
    return f;
  };
  return { root, projectPath, dir, put };
}

test('titre = dernier ai-title ; sinon premier message utilisateur (1 ligne, 80 car.) ; plus récent d\'abord', () => {
  const { root, projectPath, put } = fixture();
  put(A, [user('bonjour'), title('Premier titre'), asst('salut'), title('Titre final')], '2026-01-01T10:00:00Z');
  put(B, [user(`${'x'.repeat(200)}\nsuite`), asst('ok')], '2026-01-02T10:00:00Z');
  const list = listPastSessions(root, projectPath);
  assert.deepEqual(list.map((s) => s.id), [B, A]);
  assert.equal(list[1].title, 'Titre final');
  assert.equal(list[0].title, 'x'.repeat(80));
  assert.equal(new Date(list[0].mtime).toISOString(), '2026-01-02T10:00:00.000Z');
  assert.ok(list[0].size > 0);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'mtime', 'size', 'title']);
});

test('ignore : sans message utilisateur réel (/clear, meta, tool_result), nom non-UUID, non .jsonl', () => {
  const { root, projectPath, dir, put } = fixture();
  put(A, [user('<command-name>/clear</command-name>'), user('<local-command-stdout></local-command-stdout>')]);
  put(B, [JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } })]);
  put(C, [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })]);
  put(D, [user('vraie question')]);
  fs.writeFileSync(path.join(dir, 'pas-un-uuid.jsonl'), user('x') + '\n');
  fs.writeFileSync(path.join(dir, `${D.replace(/4/g, '5')}.txt`), user('x') + '\n');
  assert.deepEqual(listPastSessions(root, projectPath).map((s) => s.id), [D]);
});

test('lignes invalides tolérées ; dossier ou racine absents : []', () => {
  const { root, projectPath, put } = fixture();
  put(A, ['{pas du json', '', user('ok'), '[1,2]']);
  assert.deepEqual(listPastSessions(root, projectPath).map((s) => s.id), [A]);
  assert.deepEqual(listPastSessions(root, path.join(root, 'autre')), []);
  assert.deepEqual(listPastSessions(path.join(root, 'inexistant'), projectPath), []);
  assert.deepEqual(listPastSessions(root, undefined), []);
});

test("cache : un fichier inchangé n'est pas relu, un fichier modifié l'est", () => {
  const { root, projectPath, put } = fixture();
  const f = put(A, [user('un'), title('T1')]);
  const n0 = scanCount();
  assert.equal(listPastSessions(root, projectPath)[0].title, 'T1');
  assert.equal(scanCount(), n0 + 1);
  listPastSessions(root, projectPath);
  assert.equal(scanCount(), n0 + 1, 'pas de relecture');
  fs.appendFileSync(f, `${title('T3')}\n`);
  assert.equal(listPastSessions(root, projectPath)[0].title, 'T3');
  assert.equal(scanCount(), n0 + 2);
});
