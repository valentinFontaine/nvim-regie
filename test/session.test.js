import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, cleanLabel, claudeArgs } from '../src/session.js';

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

test('plusieurs sessions par projet : chaque start crée une session distincte', () => {
  const m = new SessionManager(echoer);
  const a = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const b = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  assert.notEqual(a, b);
  assert.notEqual(a.id, b.id);
  assert.equal(m.get(a.id), a);
  assert.equal(m.get(b.id), b);
  assert.equal(m.get('inconnu'), null);
  m.killAll();
});

test('mode : write par défaut, consult ajoute --permission-mode plan via args', () => {
  const calls = [];
  const m = new SessionManager({ command: process.execPath, args: (id, resume, mode) => { calls.push(mode); return ['-e', SCRIPT]; } });
  const p = { name: 'p', path: process.cwd() };
  const w = m.start(p, 80, 24);
  const c = m.start(p, 80, 24, { mode: 'consult' });
  assert.equal(w.mode, 'write');
  assert.equal(c.mode, 'consult');
  assert.deepEqual(calls, ['write', 'consult']);
  assert.throws(() => m.start(p, 80, 24, { mode: 'root' }));
  m.killAll();
});

test('claudeArgs : consult ajoute --permission-mode plan, write non', () => {
  assert.deepEqual(claudeArgs('A', undefined, 'write', 'S'), ['--session-id', 'A', '--settings', 'S']);
  assert.deepEqual(claudeArgs('A', RID, 'consult', 'S'), ['--resume', RID, '--permission-mode', 'plan', '--settings', 'S']);
});

test('cleanLabel : étiquette libre bornée, caractères sûrs seulement', () => {
  assert.equal(cleanLabel(undefined), '');
  assert.equal(cleanLabel('  base  '), 'base');
  assert.equal(cleanLabel('code-front_2.é'), 'code-front_2.é');
  assert.throws(() => cleanLabel('x'.repeat(25)));
  assert.throws(() => cleanLabel('a\nb'));
  assert.throws(() => cleanLabel('<b>'));
  assert.throws(() => cleanLabel(42));
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24, { label: ' base ' });
  assert.equal(s.label, 'base');
  assert.throws(() => m.start({ name: 'p', path: process.cwd() }, 80, 24, { label: 'a\x1bb' }));
  assert.equal(m.sessions.size, 1);
  m.killAll();
});

test('close : tue la session et la retire', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  assert.equal(m.close(s.id), true);
  assert.equal(m.get(s.id), null);
  assert.equal(m.byId(s.id), null);
  assert.equal(m.close(s.id), false);
  await until(() => s.exited);
});

test('byClaudeId : retrouve la session vivante qui suit ce JSONL, pas une session sortie', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24, { resume: RID });
  assert.equal(m.byClaudeId(RID), s);
  assert.equal(m.byClaudeId(RID.toUpperCase()), s);
  assert.equal(m.byClaudeId(s.id), null);
  s.write('q');
  await until(() => s.exited);
  assert.equal(m.byClaudeId(RID), null);
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

test('bascule de transcript vers <uuid>.jsonl : claudeId suit (byClaudeId reste juste après /clear)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regie-c-'));
  const b = path.join(dir, `${RID}.jsonl`);
  fs.writeFileSync(b, '');
  const m = new SessionManager({ ...echoer, transcript: { resolve: () => null, accept: (p) => (p === b ? b : null), intervalMs: 20 } });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'UserPromptSubmit', transcript_path: b });
  assert.equal(s.claudeId, RID);
  assert.equal(m.byClaudeId(RID), s);
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
  assert.deepEqual(Object.keys(a).sort(), ['activity', 'bg', 'branch', 'chantier', 'draft', 'excerpt', 'id', 'key', 'label', 'mode', 'project', 'since', 'state']);
  assert.equal(a.key, s.id);
  assert.equal(a.id, s.id);
  assert.equal(last().find((x) => x.project === 'b').key, 'p:b');
  assert.equal(last().find((x) => x.project === 'b').id, null);
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

test('summaries : une carte par session (vivante ou sortie), stopped seulement pour un projet sans session', async () => {
  const m = new SessionManager(echoer);
  const pa = { name: 'a', path: process.cwd() };
  const pb = { name: 'b', path: process.cwd() };
  const w = m.start(pa, 80, 24, { label: 'code' });
  const c = m.start(pa, 80, 24, { mode: 'consult' });
  let sums = m.summaries([pa, pb]);
  assert.deepEqual(sums.map((x) => [x.key, x.project, x.mode, x.label, x.state]), [
    [w.id, 'a', 'write', 'code', 'idle'],
    [c.id, 'a', 'consult', '', 'idle'],
    ['p:b', 'b', null, '', 'stopped'],
  ]);
  w.write('q');
  await until(() => w.exited);
  sums = m.summaries([pa, pb]);
  assert.equal(sums.find((x) => x.key === w.id).state, 'error', 'une session sortie reste visible jusqu\'à close');
  m.close(w.id);
  m.close(c.id);
  sums = m.summaries([pa, pb]);
  assert.deepEqual(sums.map((x) => x.key), ['p:a', 'p:b']);
  m.killAll();
});

test('summaries : une session dont le projet a quitté la config n\'est pas listée', () => {
  const m = new SessionManager(echoer);
  m.start({ name: 'parti', path: process.cwd() }, 80, 24);
  assert.deepEqual(m.summaries([{ name: 'a', path: process.cwd() }]).map((x) => x.key), ['p:a']);
  m.killAll();
});

test('summaries : chantiers listés, sessions rangées dans leur lieu, stopped par lieu vide', () => {
  const cwd = process.cwd();
  const pa = { name: 'a', path: cwd };
  const m = new SessionManager({
    ...echoer,
    listChantiers: (p) => (p.name === 'a'
      ? [{ name: 'x', path: cwd, branch: 'x' }, { name: 'y', path: cwd, branch: 'br-y' }] : []),
  });
  const s = m.start({ name: 'a', path: cwd, chantier: 'x' }, 80, 24);
  assert.equal(s.chantier, 'x');
  let sums = m.summaries([pa]);
  assert.deepEqual(sums.map((c) => [c.key, c.project, c.chantier, c.state, c.branch]), [
    ['p:a', 'a', null, 'stopped', sums[0].branch],
    [s.id, 'a', 'x', 'idle', 'x'],
    ['c:a/y', 'a', 'y', 'stopped', 'br-y'],
  ]);
  // Session principale : chantier null.
  const main = m.start(pa, 80, 24);
  assert.equal(main.chantier, null);
  // Chantier disparu de la liste (retiré à la main) : sa session vivante reste visible.
  const z = m.start({ name: 'a', path: cwd, chantier: 'z' }, 80, 24);
  sums = m.summaries([pa]);
  assert.deepEqual(sums.map((c) => [c.key, c.chantier]), [
    [main.id, null], [s.id, 'x'], ['c:a/y', 'y'], [z.id, 'z'],
  ]);
  assert.equal(m.liveIn('a', 'x'), true);
  assert.equal(m.liveIn('a', 'y'), false);
  assert.equal(m.liveIn('a', null), true);
  assert.equal(m.liveIn('b', 'x'), false);
  m.close(main.id);
  assert.equal(m.liveIn('a', null), false);
  m.killAll();
});

test('summaries : sans listChantiers dans la spec, aucun chantier', () => {
  const m = new SessionManager(echoer);
  assert.deepEqual(m.summaries([{ name: 'a', path: process.cwd() }]).map((c) => [c.key, c.chantier]), [['p:a', null]]);
});

test('summaries : la carte d\'un chantier porte l\'extrait de sa note (branche du chantier), pas le dossier principal', () => {
  const cwd = process.cwd();
  const calls = [];
  const m = new SessionManager({
    ...echoer,
    listChantiers: () => [{ name: 'y', path: cwd, branch: 'br-y' }, { name: 'z', path: cwd, branch: 'br-z' }],
    chantierNote: (p, branch) => { calls.push([p.name, branch]); return branch === 'br-y' ? 'Objectif : y' : ''; },
  });
  const sums = m.summaries([{ name: 'a', path: cwd }]);
  assert.deepEqual(sums.map((c) => [c.key, c.note]), [['p:a', undefined], ['c:a/y', 'Objectif : y'], ['c:a/z', '']]);
  assert.deepEqual(calls, [['a', 'br-y'], ['a', 'br-z']]);
  m.killAll();
});

test('close notifie le flux global', () => {
  const m = new SessionManager(echoer);
  const p = { name: 'p', path: process.cwd() };
  const lists = [];
  m.subscribeAll((msg) => lists.push(msg), [p]);
  const s = m.start(p, 80, 24);
  m.close(s.id);
  assert.deepEqual(lists.at(-1).sessions.map((x) => x.key), ['p:p']);
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

test('sendPrompt : prompt affiché tout de suite (pending), rejoué, effacé quand le transcript le porte', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regie-p-')), 't.jsonl');
  const m = new SessionManager({ ...echoer, transcript: { resolve: () => (fs.existsSync(file) ? file : null), intervalMs: 60_000 } });
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  s.sendPrompt('Bonjour régie');
  assert.deepEqual(got.find((x) => x.type === 'pending'), { type: 'pending', text: 'Bonjour régie' });
  const late = [];
  s.subscribe((msg) => late.push(msg));
  assert.ok(late.some((x) => x.type === 'pending' && x.text === 'Bonjour régie'), 'rejoué à un nouvel abonné');
  // L'intervalle normal est d'une minute : seule la relecture déclenchée par l'envoi peut lire la ligne.
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'Bonjour régie' } }) + '\n');
  await until(() => got.some((x) => x.type === 'transcript'), 2000);
  assert.equal(s.pending, null);
  const after = [];
  s.subscribe((msg) => after.push(msg));
  assert.ok(!after.some((x) => x.type === 'pending'), 'plus rejoué une fois confirmé');
  m.killAll();
});

// ── Tâches de fond ──
const bgLaunch = [
  { kind: 'tool_use', role: 'assistant', toolUseId: 't1', name: 'Bash', input: { command: 'npm run render', run_in_background: true } },
  { kind: 'tool_result', role: 'user', toolUseId: 't1', text: 'running', backgroundTaskId: 'b1' },
];
const bgNotif = (status = 'completed') => ({ kind: 'text', role: 'user', text: '<task-notification>', origin: 'task-notification', taskId: 'b1', status });

test('tâche de fond : Stop avec une tâche ouverte → running (pas done_unread), badge dans le message d\'état', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  s.noteTranscriptItems(bgLaunch);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'running');
  const st = got.filter((x) => x.type === 'state').at(-1);
  assert.deepEqual(st.bg.map((t) => [t.id, t.label]), [['b1', 'npm run render']]);
  m.killAll();
});

test('tâche de fond : la notification relance un tour (running), le Stop suivant conclut', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  s.noteTranscriptItems(bgLaunch);
  s.applyHook({ hook_event_name: 'Stop' });
  s.markRead();
  s.noteTranscriptItems([bgNotif()]);
  assert.equal(s.snap.state, 'running');
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'done_unread');
  m.killAll();
});

test('tâche de fond : après la fin de la tâche, un Stop ordinaire donne done_unread', () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.noteTranscriptItems(bgLaunch);
  s.noteTranscriptItems([bgNotif('failed')]);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'done_unread');
  m.killAll();
});

test('tâche de fond : /clear et mort du pty vident les tâches', async () => {
  const m = new SessionManager(echoer);
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.noteTranscriptItems(bgLaunch);
  s.applyHook({ hook_event_name: 'SessionEnd', reason: 'clear' });
  assert.equal(s.bg.tasks.length, 0);
  s.noteTranscriptItems(bgLaunch);
  assert.equal(s.bg.tasks.length, 1);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  s.write('q');
  await until(() => got.some((x) => x.type === 'exit'));
  assert.equal(s.bg.tasks.length, 0);
  assert.equal(s.snap.state, 'error');
  m.killAll();
});

// ── Lancements détachés (nohup … &) : sonde de processus injectée ──
const detLaunch = [
  { kind: 'tool_use', role: 'assistant', toolUseId: 'd1', name: 'Bash', input: { command: 'nohup python -u render_scenes.py > r.log 2>&1 &\necho lancé' } },
  { kind: 'tool_result', role: 'user', toolUseId: 'd1', text: 'lancé' },
];
const detSpec = (probe) => ({ ...echoer, probe, probeIntervalMs: 20, probeGraceMs: 0 });

test('détaché : le Stop est tenu en running, la sonde voit le processus, puis sa fin donne done_unread', async () => {
  let alive = true;
  const calls = [];
  const m = new SessionManager(detSpec(async (target, since) => { calls.push([target, since]); return alive; }));
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  s.noteTranscriptItems(detLaunch);
  s.applyHook({ hook_event_name: 'Stop' });
  assert.equal(s.snap.state, 'running');
  assert.equal(s.bg.tasks[0].label, 'render_scenes.py');
  await until(() => calls.length >= 2, 2000);
  assert.equal(calls[0][0], 'render_scenes.py');
  assert.equal(s.snap.state, 'running', 'tant que le processus vit');
  alive = false;
  await until(() => s.bg.tasks.length === 0, 2000);
  assert.equal(s.snap.state, 'done_unread');
  m.killAll();
});

test('détaché : sonde impossible (null) → la tâche reste ouverte ; nouveau prompt → plus de maintien', async () => {
  const calls = [];
  const m = new SessionManager(detSpec(async () => { calls.push(1); return null; }));
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.noteTranscriptItems(detLaunch);
  s.applyHook({ hook_event_name: 'Stop' });
  await until(() => calls.length >= 2, 2000);
  assert.equal(s.bg.tasks.length, 1);
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(s.snap.state, 'running');
  m.killAll();
});

test('détaché : la fin du processus pendant un tour en cours ne conclut pas ce tour', async () => {
  let alive = true;
  const m = new SessionManager(detSpec(async () => alive));
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.applyHook({ hook_event_name: 'UserPromptSubmit' });
  s.noteTranscriptItems(detLaunch);
  alive = false;
  await until(() => s.bg.tasks.length === 0, 2000);
  assert.equal(s.snap.state, 'running');
  m.killAll();
});

test('détaché : /clear arrête la sonde et vide les tâches', async () => {
  let n = 0;
  const m = new SessionManager(detSpec(async () => { n++; return true; }));
  const s = m.start({ name: 'p', path: process.cwd() }, 80, 24);
  s.noteTranscriptItems(detLaunch);
  await until(() => n >= 1, 2000);
  s.applyHook({ hook_event_name: 'SessionEnd', reason: 'clear' });
  assert.equal(s.bg.tasks.length, 0);
  const seen = n;
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(n - seen <= 1, 'plus de sonde après /clear');
  m.killAll();
});

// ── Brouillon Neovim ──
test('brouillon : setDraft est porté par le message d\'état et par la carte, retiré quand le buffer se vide', () => {
  const m = new SessionManager(echoer);
  const pa = { name: 'a', path: process.cwd() };
  const lists = [];
  m.subscribeAll((msg) => lists.push(msg), [pa]);
  const s = m.start(pa, 80, 24);
  const got = [];
  s.subscribe((msg) => got.push(msg));
  const card = () => lists.at(-1).sessions.find((x) => x.project === 'a');
  assert.equal(s.draft, false);
  assert.equal(card().draft, false);
  s.setDraft(true);
  assert.equal(got.filter((x) => x.type === 'state').at(-1).draft, true);
  assert.equal(card().draft, true);
  const n = got.length;
  s.setDraft(true); // inchangé : aucun nouveau message
  s.setDraft('oui'); // non booléen : ignoré
  assert.equal(got.length, n);
  assert.equal(s.draft, true);
  s.setDraft(false);
  assert.equal(got.filter((x) => x.type === 'state').at(-1).draft, false);
  assert.equal(card().draft, false);
  m.killAll();
});
