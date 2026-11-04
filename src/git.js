// Branche courante d'un dépôt, lue dans .git/HEAD (ni `git` ni shell). Le dossier vient de la config.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BRANCH = 100;

export function readBranch(dir) {
  try {
    if (typeof dir !== 'string' || !dir) return null;
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8').slice(0, 4096));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').split(/\r?\n/, 1)[0].trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1].slice(0, MAX_BRANCH);
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}
