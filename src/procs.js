// Sonde de processus (Windows, lecture seule) : un processus vivant porte-t-il `target` dans sa ligne de commande ?
// Aucune interpolation : la cible et la date passent par des variables d'environnement, le script est fixe,
// le processus est lancé avec un tableau d'arguments (pas de shell).
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 15_000;
const SKIP = '^(bash|sh|zsh|grep|tail|cat|ls|sed|awk|git|claude|powershell|pwsh|cmd|conhost|node-pty|rg)(\\.exe)?$';

const SCRIPT = [
  "$t = $env:REGIE_TARGET; $s = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:REGIE_SINCE).UtcDateTime",
  'Get-CimInstance Win32_Process | Where-Object {',
  '  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($t) -and',
  `  $_.Name -notmatch '${SKIP}' -and $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $s`,
  "} | Select-Object -First 1 | ForEach-Object { 'FOUND' }",
].join('\n');

/** Arguments et environnement de la sonde (exposé pour les tests). */
export function probeCommand(target, sinceMs) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
    env: { ...process.env, REGIE_TARGET: String(target), REGIE_SINCE: String(Math.floor(sinceMs)) },
  };
}

/** true : vu vivant ; false : absent ; null : sonde impossible (hors Windows, délai dépassé, erreur). Ne lève jamais. */
export function findLive(target, sinceMs) {
  if (process.platform !== 'win32' || typeof target !== 'string' || !/^[\w.-]{1,80}$/.test(target) || !Number.isFinite(sinceMs)) {
    return Promise.resolve(null);
  }
  const { command, args, env } = probeCommand(target, sinceMs);
  return new Promise((resolve) => {
    try {
      execFile(command, args, { env, timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout).includes('FOUND'));
      });
    } catch { resolve(null); }
  });
}
