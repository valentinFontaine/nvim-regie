# Étape 5 — tableau de bord multi-sessions

## Périmètre
Sessions **vivantes** seulement, une par projet de `config.json`. Persistance et `--resume` (D6) = étape 6.

## Fonctionnement
- **Flux global** : chaque client WebSocket reçoit `{type:'sessions', sessions:[…]}` dès la connexion (sans `start`),
  puis à chaque changement d'état, démarrage ou mort. Résumé : `{project, branch, state, activity, since, excerpt}` ;
  un projet de la config sans session vaut `state:'stopped'` (« non lancé », colonne Au repos).
- **Branche** : `src/git.js` lit `.git/HEAD` du chemin de la config (pas de `git`, pas de shell ; `.git` fichier des
  worktrees géré ; HEAD détaché → hash court ; erreur → `null`).
- **Messages WS** : `start` crée ou rattache, `detach` revient au tableau de bord sans rien tuer, `read` / `interrupt` /
  `input`… n'agissent que sur la session rattachée.
- **Front** : routage par hash (`#/` tableau de bord, `#/s/<projet>` session). Logique pure (colonnes, tri, durées,
  compteur, `g n`) dans `public/dashboard.js`, testée. Contenu des cartes inséré en `textContent`.
- **Colonnes** : Besoin de toi (needs_you et error) / En cours / Terminé, non lu / Au repos (idle et non lancé).
  Tri par `since` croissant : l'attente la plus longue en tête.
- **Notifications** (needs_you uniquement) : bip WebAudio + `Notification` système (autorisation via le bouton
  « Activer les notifications »), sauf si la session est déjà affichée et la fenêtre active. Titre : `(n) nvim-regie`.
- **Clavier** (tableau de bord) : `j`/`k`, `Entrée`, `g n` (prochaine session qui attend).
- `done_unread` → `idle` à l'ouverture de la session (inchangé).

## Hors périmètre (repoussé)
D16 barre latérale compacte, raccourcis via RPC Neovim (D12), raccourci clavier pour Interrompre, persistance (étape 6).

## Test instable connu
`test/session.test.js` plante par intermittence (violation d'accès native, `0xC0000005`) : déjà 4 échecs sur 10
avant l'étape 5. Voir `en-suspens.md`.
