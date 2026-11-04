import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session.js';

const SCRIPT = [
  "process.stdin.setRawMode && process.stdin.setRawMode(true);",
  "process.stdin.on('data', d => { process.stdout.write('ECHO:' + d); if (String(d).includes('q')) process.exit(3); });",
  "process.stdout.write('READY\\n');",
].join('');
const echoer = { command: process.execPath, args: () => ['-e', SCRIPT] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await wait(50); }
  assert.fail('délai dépassé');
}

test('démarre, diffuse, écho, resize, exit', async () => {
  const m = new SessionManager(echoer);
  const got = [];
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.subscribe((msg) => got.push(msg));
  await until(() => got.some((x) => x.type === 'data' && x.data.includes('READY')));
  s.write('hello');
  await until(() => got.some((x) => x.type === 'data' && x.data.includes('ECHO:hello')));
  s.resize(100, 30);
  s.write('q');
  await until(() => got.some((x) => x.type === 'exit'));
  assert.equal(got.find((x) => x.type === 'exit').code, 3);
  m.killAll();
});

test('rejeu du tampon à la reconnexion', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const first = [];
  const unsub = s.subscribe((msg) => first.push(msg));
  await until(() => first.some((x) => x.data?.includes('READY')));
  unsub();
  const second = [];
  s.subscribe((msg) => second.push(msg));
  assert.ok(second[0].type === 'data' && second[0].data.includes('READY'));
  m.killAll();
});

test('resize et write valident leurs entrées', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  assert.throws(() => s.resize('a', 1));
  assert.throws(() => s.resize(0, 10));
  assert.throws(() => s.resize(10, 100000));
  assert.throws(() => s.write(42));
  m.killAll();
});

test('une seule session par projet', () => {
  const m = new SessionManager(echoer);
  const a = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const b = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  assert.equal(a, b);
  m.killAll();
});

test('transcript : items diffusés puis rejoués à un nouvel abonné', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regie-s-')), 't.jsonl');
  const m = new SessionManager({
    ...echoer,
    transcript: { resolve: () => (fs.existsSync(file) ? file : null), intervalMs: 20 },
  });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'salut' } }) + '\n');
  await until(() => got.some((x) => x.type === 'transcript'));
  const first = got.find((x) => x.type === 'transcript');
  assert.equal(first.items[0].text, 'salut');

  const late = [];
  s.subscribe((msg) => late.push(msg));
  assert.ok(late.some((x) => x.type === 'transcript' && x.items[0].text === 'salut'));
  m.killAll();
});

test("l'environnement du pty ne transmet pas les marqueurs d'une session Claude Code parente", async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.CLAUDECODE = '1';
  const script = "process.stdout.write('ENV[' + process.env.CLAUDE_CODE_CHILD_SESSION + '|' + process.env.CLAUDECODE + ']\\n')";
  const m = new SessionManager({ command: process.execPath, args: () => ['-e', script] });
  const got = [];
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.subscribe((msg) => got.push(msg));
  try {
    await until(() => got.some((x) => x.type === 'data' && x.data.includes('ENV[')));
    const out = got.filter((x) => x.type === 'data').map((x) => x.data).join('');
    assert.ok(out.includes('ENV[undefined|undefined]'), out);
  } finally {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.CLAUDECODE;
    m.killAll();
  }
});

test('applyHook : état, activité, rejeu à un nouvel abonné, extrait au Stop', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  assert.equal(s.snap.state, 'idle');
  s.applyHook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  s.applyHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const states = got.filter((x) => x.type === 'state');
  assert.deepEqual(states.map((x) => x.state), ['idle', 'running', 'running']); // le premier est le rejeu de l'état initial à l'abonnement
  assert.equal(states.at(-1).activity, 'Bash ls');
  s.applyHook({ hook_event_name: 'Stop', last_assistant_message: 'Terminé : '.padEnd(500, 'x') });
  const last = got.filter((x) => x.type === 'state').at(-1);
  assert.equal(last.state, 'done_unread');
  assert.ok(last.excerpt.length <= 200 && last.excerpt.startsWith('Terminé'));
  const late = [];
  s.subscribe((msg) => late.push(msg));
  assert.equal(late.find((x) => x.type === 'state').state, 'done_unread');
  s.markRead();
  assert.equal(got.filter((x) => x.type === 'state').at(-1).state, 'idle');
  m.killAll();
});

test('applyHook : charge invalide ignorée sans exception', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  assert.doesNotThrow(() => { s.applyHook(null); s.applyHook('x'); s.applyHook({}); });
  assert.equal(s.snap.state, 'idle');
  m.killAll();
});

test('mort du pty → état error diffusé', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  await until(() => got.some((x) => x.data?.includes('READY')));
  s.write('q');
  await until(() => got.some((x) => x.type === 'state' && x.state === 'error'));
  m.killAll();
});

test('transcript_path différent (/clear, /resume) : le suivi bascule sur le nouveau fichier', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-r-'));
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  const line = (t) => JSON.stringify({ type: 'user', uuid: t, message: { content: t } }) + '\n';
  fs.writeFileSync(a, line('ancien'));
  fs.writeFileSync(b, line('nouveau'));
  const m = new SessionManager({
    ...echoer,
    transcript: {
      resolve: () => a,
      accept: (p) => (p === b ? b : null),
      intervalMs: 20,
    },
  });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  await until(() => got.some((x) => x.type === 'transcript' && x.items[0].text === 'ancien'));
  s.applyHook({ hook_event_name: 'UserPromptSubmit', transcript_path: 'C:\hors\racine.jsonl' });
  s.applyHook({ hook_event_name: 'UserPromptSubmit', transcript_path: b });
  await until(() => got.some((x) => x.type === 'transcript' && x.items[0].text === 'nouveau'));
  assert.ok(got.some((x) => x.type === 'transcript-reset'));
  assert.deepEqual(s.items.map((i) => i.text), ['nouveau']);
  m.killAll();
});
