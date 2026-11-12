import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { probeCommand, findLive } from '../src/procs.js';

test('probeCommand : cible et date dans l\'environnement, jamais dans le script', () => {
  const { args, env } = probeCommand('render_scenes.py', 1234.7);
  assert.equal(env.REGIE_TARGET, 'render_scenes.py');
  assert.equal(env.REGIE_SINCE, '1234');
  assert.ok(!args.join(' ').includes('render_scenes'));
});

test('findLive : cible invalide ou date invalide → null, sans lancer de processus', async () => {
  assert.equal(await findLive('a b;c.py', 1), null);
  assert.equal(await findLive('', 1), null);
  assert.equal(await findLive('x.py', NaN), null);
});

test('findLive : vu vivant puis absent (processus réel détaché)', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const name = `regie_probe_${process.pid}.js`;
  const since = Date.now() - 1000;
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)', name], { stdio: 'ignore', windowsHide: true });
  try {
    assert.equal(await findLive(name, since), true);
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once('exit', r));
  assert.equal(await findLive(name, since), false);
});
