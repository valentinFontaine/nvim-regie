// Marqueurs posés par un Claude Code parent. Hérités, ils font croire à notre `claude` qu'il est
// une session enfant : « Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker »
// (vérifié sur claude 2.1.x), donc aucun fichier JSONL et une conversation vide dans la page.
const PARENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
];

/** Copie de l'environnement sans les marqueurs d'une session Claude Code parente. */
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of PARENT_MARKERS) delete out[k];
  return out;
}
