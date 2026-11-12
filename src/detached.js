// Repère, dans une commande Bash/PowerShell, un lancement détaché (nohup, & final, Start-Process, start /b)
// et en tire le nom du fichier lancé : c'est lui qu'on cherche ensuite dans les processus vivants.
// Heuristique assumée : une commande détachée sans nom de fichier reconnaissable n'est pas détectée.

const FILE_RE = /^[\w.-]{1,80}\.(py|js|mjs|cjs|ps1|sh|bat|cmd|exe)$/i;
const SPLIT_RE = /\r?\n|;|&&|\|\|/;
const ENDS_AMP_RE = /(^|[^&>|\d])&\s*$/;
const DETACH_RE = /(^|\s)(nohup|start-process|start\s+\/b)(\s|$)/i;

function unquote(tok) {
  const m = /^(["'])(.*)\1$/.exec(tok);
  return m ? m[2] : tok;
}

/** Nom de fichier lancé en détaché par `command`, ou null. */
export function detachedTarget(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const seg of command.split(SPLIT_RE)) {
    const s = seg.trim();
    if (!s || !(DETACH_RE.test(s) || ENDS_AMP_RE.test(s))) continue;
    let target = null;
    for (const raw of s.split(/\s+/)) {
      if (/^\d*>/.test(raw)) break; // redirection : le reste n'est plus la commande
      const tok = unquote(raw.replace(/&+$/, ''));
      const base = tok.split(/[\\/]/).pop();
      if (FILE_RE.test(base)) target = base;
    }
    if (target) return target;
  }
  return null;
}
