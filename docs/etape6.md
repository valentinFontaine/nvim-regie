# Étape 6 — confort d'usage

## Lot 1 : plantage node-pty, prompt instantané, barre de statut, réflexion

### Plantage natif intermittent (0xC0000005)
- Mesure : `test/session.test.js` plantait 4 fois sur 10, déjà avant l'étape 5.
- Cause trouvée : avec `useConptyDll`, node-pty ne ferme la pseudo-console qu'au `kill()`, rien à la sortie du processus. `Session.kill()` et `Nvim.kill()` sautaient le `kill()` d'un pty déjà sorti.
- Correctif : drapeau `released`, `kill()` appelé une fois même après la sortie. Mesure : 1 plantage sur 10.
- Reste : un plantage natif résiduel. Piste non tentée : node-pty 1.2.0-beta (changement de dépendance, à décider).

### Prompt affiché instantanément
- Le délai (~0,5 s) venait du sondage du JSONL toutes les 500 ms.
- `Session.sendPrompt` émet `pending` (affichage optimiste, grisé, bord pointillé) puis appelle `TranscriptTail.kick()` : sondage à 50 ms pendant 3 s.
- Le prompt optimiste est retiré dès qu'un vrai message utilisateur arrive du JSONL ; il est rejoué à un nouvel abonné tant qu'il n'est pas confirmé.

### Barre de statut
- `--settings` injecte une `statusLine` relais : `node scripts/statusline-relay.mjs <port> <jeton> <id>`.
- Le relais exécute la `statusLine` de `~/.claude/settings.json` avec le JSON reçu sur stdin, rend sa sortie au terminal (barre inchangée) et la poste à `/status/<jeton>/<id>` (même contrôle que les hooks).
- La commande exécutée vient uniquement du fichier de réglages de l'utilisateur, jamais de données reçues ; garde-fou contre l'auto-appel.
- Rendu : `public/ansi.js` (SGR : gras, 16 couleurs, 256, RGB), spans en `textContent`, entre la conversation et Neovim.
- À vérifier à la main : la `statusLine` de `--settings` l'emporte sur celle de `~/.claude/settings.json`.

### Réflexion (thinking)
- Vérifié dans le binaire 2.1.318 : `showThinkingSummaries` vaut `false` par défaut, donc blocs thinking vides dans le JSONL.
- `--settings` injecte `showThinkingSummaries: true` ; le rendu « Réflexion » existait déjà.
