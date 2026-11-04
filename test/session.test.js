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

test('SessionEnd reason=clear ou resume : conversation vidée côté serveur et transcript-reset diffusé', async () => {
  for (const reason of ['clear', 'resume']) {
    const m = new SessionManager(echoer);
    const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
    const got = [];
    s.subscribe((msg) => got.push(msg));
    s.items.push({ kind: 'text', role: 'user', text: 'ancien' });
    s.applyHook({ hook_event_name: 'UserPromptSubmit' });
    s.applyHook({ hook_event_name: 'SessionEnd', reason });
    assert.ok(got.some((x) => x.type === 'transcript-reset'), reason);
    assert.deepEqual(s.items, []);
    assert.equal(s.snap.state, 'idle');
    m.killAll();
  }
});

test('SessionEnd d\'une autre raison : conversation conservée', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.items.push({ kind: 'text', role: 'user', text: 'gardé' });
  s.applyHook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  assert.equal(s.items.length, 1);
  m.killAll();
});

test('message « [Request interrupted by user] » dans le transcript : running → idle', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regie-i-')), 't.jsonl');
  const m = new SessionManager({ ...echoer, transcript: { resolve: () => (fs.existsSync(file) ? file : null), intervalMs: 20 } });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(s.snap.state, 'running');
  const user = (text) => JSON.stringify({ type: 'user', uuid: text, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  fs.writeFileSync(file, user('Écris un poème'));
  await wait(300);
  assert.equal(s.snap.state, 'running', 'un prompt ordinaire ne change rien');
  fs.appendFileSync(file, user('[Request interrupted by user]'));
  await until(() => s.snap.state === 'idle');
  assert.equal(got.filter((x) => x.type === 'state').at(-1).state, 'idle');
  m.killAll();
});

test('interruption : un état done_unread ou error n\'est pas écrasé', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'Stop' });
  s.noteTranscriptItems([{ kind: 'text', role: 'user', text: '[Request interrupted by user]' }]);
  assert.equal(s.snap.state, 'done_unread');
  m.killAll();
});

test('interrupt : envoie Échap au pty de claude, sans effet une fois terminé', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  await until(() => got.some((x) => x.data?.includes('READY')));
  s.interrupt();
  await until(() => got.some((x) => x.type === 'data' && x.data.includes('ECHO:\x1b')));
  s.write('q');
  await until(() => got.some((x) => x.type === 'exit'));
  assert.doesNotThrow(() => s.interrupt());
  m.killAll();
});

test('subscribeAll : liste à l\'abonnement (projets sans session = stopped), puis à chaque changement', async () => {
  const m = new SessionManager(echoer);
  const pa = { name: 'a', path: process.cwd() };
  const pb = { name: 'b', path: process.cwd() };
  const lists = [];
  const unsub = m.subscribeAll((msg) => lists.push(msg), [pa, pb]);
  assert.equal(lists[0].type, 'sessions');
  assert.deepEqual(lists[0].sessions.map((s) => [s.project, s.state]), [['a', 'stopped'], ['b', 'stopped']]);
  const s = m.start(pa, 80, 24);
  const last = () => lists.at(-1).sessions;
  assert.equal(last().find((x) => x.project === 'a').state, 'idle');
  assert.equal(last().find((x) => x.project === 'b').state, 'stopped');
  s.applyHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const a = last().find((x) => x.project === 'a');
  assert.equal(a.state, 'running');
  assert.equal(a.activity, 'Bash ls');
  assert.deepEqual(Object.keys(a).sort(), ['activity', 'branch', 'excerpt', 'project', 'since', 'state']);
  const n = lists.length;
  unsub();
  s.applyHook({ hook_event_name: 'Stop', last_assistant_message: 'fini' });
  assert.equal(lists.length, n);
  m.killAll();
});

test('subscribeAll : la mort du pty est diffusée (error)', async () => {
  const m = new SessionManager(echoer);
  const p = { name: 'p', path: process.cwd() };
  const lists = [];
  m.subscribeAll((msg) => lists.push(msg), [p]);
  const s = m.start(p, 80, 24);
  s.subscribe(() => {});
  await wait(500);
  s.write('q');
  await until(() => lists.at(-1).sessions[0].state === 'error');
  m.killAll();
});

test('summaries : branche lue dans la config (null sans dépôt)', () => {
  const m = new SessionManager(echoer);
  const sums = m.summaries([{ name: 'x', path: process.cwd() }, { name: 'y', path: 'C:\inexistant-regie' }]);
  assert.equal(typeof sums[0].branch === 'string' || sums[0].branch === null, true);
  assert.equal(sums[1].branch, null);
});

const RID = '99999999-9999-4999-8999-999999999999';

test('reprise : args reçoit l\'id de reprise, claudeId = uuid repris, id (hooks) reste distinct', () => {
  const calls = [];
  const resolved = [];
  const m = new SessionManager({
    command: process.execPath,
    args: (id, resume) => { calls.push([id, resume]); return ['-e', SCRIPT]; },
    transcript: { resolve: (p, id) => { resolved.push(id); return null; }, intervalMs: 20 },
  });
  const p = { name: 'p', path: process.cwd() };
  const s = m.start(p, 80, 24, { resume: RID });
  assert.equal(s.claudeId, RID);
  assert.notEqual(s.id, RID);
  assert.deepEqual(calls[0], [s.id, RID]);
  assert.equal(m.byId(s.id), s);
  const n = m.start({ name: 'q', path: process.cwd() }, 80, 24);
  assert.equal(n.claudeId, n.id);
  assert.equal(calls[1][1], undefined);
  return wait(150).then(() => {
    assert.ok(resolved.includes(RID), 'le suivi du JSONL cherche le fichier de la session reprise');
    assert.ok(resolved.includes(n.id));
    m.killAll();
  });
});

test('reprise : l\'id de reprise est refusé s\'il n\'est pas un UUID', () => {
  const m = new SessionManager(echoer);
  assert.throws(() => m.start({ name: 'p', path: process.cwd() }, 80, 24, { resume: '../x' }));
  assert.throws(() => m.start({ name: 'p', path: process.cwd() }, 80, 24, { resume: 42 }));
  assert.equal(m.sessions.size, 0);
});

test('restart : tue la session vivante du projet et en démarre une autre (reprise)', async () => {
  const m = new SessionManager(echoer);
  const p = { name: 'p', path: process.cwd() };
  const a = m.start(p, 80, 24);
  const b = m.restart(p, 80, 24, { resume: RID });
  assert.notEqual(a, b);
  assert.equal(m.sessions.get('p'), b);
  assert.equal(b.claudeId, RID);
  assert.equal(m.byId(a.id), null);
  await until(() => a.exited);
  assert.equal(m.sessions.get('p'), b, 'la mort de l\'ancienne ne touche pas la nouvelle');
  m.killAll();
});

test('historique rejoué (reprise) : une ancienne interruption ne repasse pas un tour en cours à idle', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regie-h-')), 't.jsonl');
  const user = (text) => JSON.stringify({ type: 'user', uuid: text, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  fs.writeFileSync(file, user('vieille question') + user('[Request interrupted by user]'));
  const m = new SessionManager({ ...echoer, transcript: { resolve: () => file, intervalMs: 20 } });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  await until(() => s.items.length === 2);
  await wait(150);
  assert.equal(s.snap.state, 'running', 'l\'historique n\'est pas une interruption en direct');
  fs.appendFileSync(file, user('[Request interrupted by user]'));
  await until(() => s.snap.state === 'idle');
  m.killAll();
});
