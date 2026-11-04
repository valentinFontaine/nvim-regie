# Étape 1 — serveur + pty `claude` + xterm.js

## Lancer
1. `npm install` (déjà fait), puis `npm start` une première fois : crée `%LOCALAPPDATA%\nvim-regie\config.json` et s'arrête.
2. Éditer ce fichier : `projects: [{ "name": "…", "path": "C:\\…" }]` (chemins absolus, liste fermée).
3. `npm start` (ou le raccourci créé par `scripts/creer-raccourci.ps1`) : le navigateur s'ouvre, choisir un projet, « Lancer ».

## Vérifié
- `claude` 2.1.318, `--session-id <uuid>` (D5) ; `node-pty` 1.1.0 fonctionne sous Node 24 / Windows.
- À observer à la main : encodage du dossier de projet dans `~/.claude/projects/` (D5).

## Choix techniques
- `node-pty` : `useConptyDll: true`. Sans lui, `kill()` lance un agent qui échoue (`AttachConsole failed`) et le pty n'est pas tué.
- Après la mort d'un pty, un worker de `node-pty` garde le processus Node en vie : `npm test` utilise `--test-force-exit`.
- Garde-fous : écoute `127.0.0.1`, contrôle `Host`, jeton → cookie `HttpOnly; SameSite=Strict`, `Origin` + cookie sur le WebSocket, fichiers servis en liste fermée, projet résolu par nom contre `config.json`.
- Une session par projet ; fermer l'onglet ne la tue pas ; un onglet rouvert rejoue les ~200 Ko de sortie.
