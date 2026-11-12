import test from 'node:test';
import assert from 'node:assert/strict';
import { detachedTarget } from '../src/detached.js';

test('cas réel SRMix : nohup + variable + redirections + echo', () => {
  const cmd = 'cd "C:/x/SRMix/.claude/worktrees/formation-shutoff-mris" && PY=/c/Python/python.exe\n'
    + 'nohup $PY -I -u render_scenes.py > /tmp/render_all.log 2>&1 &\n'
    + 'echo lancé';
  assert.equal(detachedTarget(cmd), 'render_scenes.py');
});

test('chemin avec dossiers : nom de base', () => {
  assert.equal(detachedTarget('nohup python tools/sub/run_x.py --n 3 > o.log 2>&1 &'), 'run_x.py');
});

test('& final sans nohup', () => {
  assert.equal(detachedTarget('node serveur.js &'), 'serveur.js');
});

test('Start-Process et start /b', () => {
  assert.equal(detachedTarget('Start-Process python -ArgumentList run.py'), 'run.py');
  assert.equal(detachedTarget('start /b cmd /c lance.bat'), 'lance.bat');
});

test('non détaché : && , pipe, redirection 2>&1', () => {
  assert.equal(detachedTarget('cmd1 && python a.py'), null);
  assert.equal(detachedTarget('ls | grep x.py'), null);
  assert.equal(detachedTarget('python a.py > o.log 2>&1'), null);
  assert.equal(detachedTarget('python a.py 2>&1'), null);
});

test('détaché sans nom de fichier reconnaissable : null', () => {
  assert.equal(detachedTarget('foo &'), null);
  assert.equal(detachedTarget('nohup sleep 100 &'), null);
});

test('entrées invalides : null', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) assert.equal(detachedTarget(v), null);
});

test('nom hors alphabet sûr rejeté', () => {
  assert.equal(detachedTarget('nohup python "a b;c.py" &'), null);
});
