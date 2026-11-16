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
- Vérifié à la main (2026-11-06) : la `statusLine` de `--settings` l'emporte sur celle de `~/.claude/settings.json` ; la barre affichée est identique à celle du terminal.

### Réflexion (thinking)
- Vérifié dans le binaire 2.1.318 : `showThinkingSummaries` vaut `false` par défaut, donc blocs thinking vides dans le JSONL.
- `--settings` injecte `showThinkingSummaries: true` ; le rendu « Réflexion » existait déjà. Vérifié à la main (2026-11-06) : les blocs ont du texte.

## Lot 2 : interface de la vue session

### Neovim dans un cadre, en bas ou à droite
- `#work` = conversation (ou sélecteur) + `#side` (barre de statut + cadre Neovim bordé, coins arrondis, marge intérieure).
- En bas (défaut) : cadre aligné sur la colonne de conversation (60rem max), 16rem de haut. À droite : page coupée en deux moitiés, conversation sur toute sa moitié (padding fixe : un padding en % se calcule sur la largeur du parent, ce qui écrasait le texte).
- Bouton « Neovim à droite / en bas » dans l'en-tête ; choix gardé par le navigateur (`localStorage`, lecture protégée). Le `ResizeObserver` existant refait le `fit` et redimensionne le pty nvim.
- Tiroir terminal inchangé (toute la largeur).

### Ligne d'activité sous la réponse
- Observé sur 2.1.318 : un tour finit en général par une ligne JSONL `system` / `turn_duration` (`durationMs`, `timestamp`), y compris pour un tour de 3 s ; mais 2 des 6 derniers fichiers du projet n'en ont aucune (cause non identifiée), d'où le repli ci-dessous. Le verbe aléatoire du terminal (« Cogitated », « Reflecting ») n'y est pas : non repris.
- Parseur : item `{kind: "turn", role: "system", durationMs}` ; rendu `✻ 1 min 8 s · fini à 09:34` (arrondi à la seconde comme le terminal).
- Pendant le tour (état `running` / `needs_you`) : `✻ En cours… 12 s · <activité du hook PreToolUse>`, rafraîchie chaque seconde, toujours en bas de la conversation.
- Au `Stop`, ligne provisoire calculée côté navigateur, remplacée par `turn_duration` quand il arrive (repli si absent).

### Brouillon Neovim sur la carte
- Problème : j'ouvre une session terminée (→ « au repos »), j'écris un début de réponse dans Neovim, je pars ailleurs : la carte est indiscernable d'une session sans rien à faire.
- `nvim/regie.lua` : `nvim_buf_attach` sur le buffer de prompt ; au changement seulement (au moins une ligne non blanche ↔ vide), `rpcnotify 'regie_draft'` (booléen). Le vidage après envoi notifie `false`.
- `Session.draft` (booléen indépendant de la machine à états, repassé à `false` à la mort de nvim), porté par le message d'état et les cartes.
- Tableau de bord : `idle` + brouillon ⇒ colonne « Terminé, non lu » ; `running` / `needs_you` gardent leur colonne ; badge violet « ✎ brouillon » sur la carte et dans la barre de session.
- Limite : le brouillon vit dans le pty de Neovim côté serveur ; redémarrer le serveur le perd, comme la session.

### Modèle en cours dans la barre du haut
- Source principale : le JSON que `claude` donne à la statusLine (`model.id`, `model.display_name`), lu par le relais (`scripts/statusline-relay.mjs`) et posté avec le texte ; il suit donc `/model`.
- Repli : le champ `message.model` des réponses du transcript (id brut, `<synthetic>` ignoré), utilisé avant la première statusLine, ou si le modèle des réponses diffère. Le nom lisible est gardé quand l'id est le même.
- `Session.model` → champ `model` du message d'état (chaîne affichable) ; pastille `#model` dans l'en-tête, visible seulement dans la vue session.

### Bandeau « Serveur arrêté »
- Problème (2026-11-16) : fermer la fenêtre de la régie arrête le serveur, mais la page reste affichée ; un clic sur une carte ouvre une vue qui attend indéfiniment, comme une session « qui ne se charge pas ». Seul indice : « déconnecté » dans la barre d'état.
- Mesuré au passage (banc WebSocket, reprise de sessions de 4,6 et 44 Mo) : conversation affichée en ~1 s, Neovim ~4,4 s, interface de `claude` ~5,8 s, indépendamment de la taille du transcript.
- `ws.onclose` : bandeau rouge `#offline` sous l'en-tête et classe `offline` sur `body` (tableau de bord et vue session grisés, non cliquables).
- Pas de reconnexion automatique : le jeton est régénéré à chaque démarrage, on rouvre la page depuis le lien du serveur relancé.
