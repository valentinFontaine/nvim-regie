# nvim-regie (nom provisoire)

Interface web locale pour piloter plusieurs sessions Claude Code en parallèle, où **Neovim est la zone de saisie**.

En une phrase : une « régie » qui montre l'état de tous mes agents, avec pour chaque session la conversation joliment rendue et un vrai Neovim pour écrire le prompt, tout en gardant la réponse précédente visible.

## Le problème à résoudre

- Dans le CLI, `Ctrl+G` ouvre le prompt dans `$EDITOR`, mais masque la conversation pendant l'édition. Impossible de relire ou de copier la réponse de Claude en écrivant.
- Claude Desktop a une belle interface et des sessions parallèles, mais pas de saisie dans Neovim.
- Quand plusieurs agents tournent, il faut savoir d'un coup d'œil lequel travaille, lequel a fini, et surtout lequel attend une réponse.

## Contraintes non négociables

- **Rester sur l'abonnement Claude.** On lance le vrai `claude` interactif. Pas d'Agent SDK avec clé API, pas d'appel direct à l'API Anthropic.
- **Neovim est l'éditeur de prompt.** Pas un éditeur web qui imite Vim : un vrai `nvim` avec ma config.
- **Tout est local.** Le serveur n'écoute que sur `127.0.0.1`.

## Architecture

### 1. Une session = un pty qui lance `claude`
- Le serveur Node lance `claude` en mode interactif dans un pty (`node-pty`), dans le dossier du projet.
- Ce terminal brut reste accessible dans un tiroir repliable (xterm.js) pour les commandes slash, les menus et les permissions.

### 2. L'affichage lit le transcript JSONL, pas l'écran
- Claude Code écrit chaque session dans `~/.claude/projects/<dossier-encodé>/<id-session>.jsonl`.
- Le serveur suit ce fichier (façon `tail -f`) et pousse chaque nouvelle entrée au navigateur par WebSocket.
- Le front rend le Markdown avec coloration syntaxique et replie les appels d'outils.
- **Le format JSONL est interne et non documenté.** Avant d'écrire le parseur : ouvrir de vrais fichiers de session, documenter la structure observée dans `docs/jsonl-format.md`, et écrire un parseur tolérant (ignorer les types inconnus, ne jamais planter sur une ligne invalide).

### 3. La saisie : Neovim dans le navigateur
- Un second pty lance `nvim --listen <socket>` sur un buffer de prompt propre à la session.
- Il est affiché avec xterm.js sous la conversation.
- Le serveur se connecte au socket avec le client npm `neovim` (msgpack-rpc).

### 4. L'envoi : de Neovim vers le pty de Claude
- Un raccourci Nvim (par défaut `<leader><CR>`) fait un `rpcnotify` vers le serveur.
- Le serveur lit le buffer (`nvim_buf_get_lines`), l'écrit dans le pty de `claude` en bracketed paste (`\x1b[200~` + texte + `\x1b[201~`), puis envoie `\r`, et vide le buffer.
- Pour Claude Code, c'est un prompt collé puis validé : un vrai message utilisateur.

### 5. L'état des sessions : les hooks de settings
- Des hooks de type HTTP dans `~/.claude/settings.json` envoient les événements au serveur local.
- Machine à états par session : `running`, `needs_you`, `done_unread`, `idle`, `error`.
- Correspondance prévue (noms d'événements et contenu des données **à vérifier dans la doc des hooks** de la version installée) :
  - `UserPromptSubmit` → `running`
  - `PreToolUse` → met à jour l'activité affichée (outil + cible)
  - `Notification` avec le matcher `permission_prompt` → `needs_you`, ouvre le tiroir du terminal
  - `Stop` → `done_unread`, avec un extrait de la dernière réponse tiré du JSONL
  - `SessionEnd` → `idle`
  - Mort du pty → `error`
- `done_unread` repasse en `idle` quand j'ouvre la session.

### 6. Le tableau de bord (page d'accueil)
- Colonnes : « Besoin de toi », « En cours », « Terminé, non lu », « Au repos ».
- Chaque carte : projet, branche, état, activité en cours, durée, extrait de la dernière réponse.
- Les sessions qui attendent remontent en premier, triées par durée d'attente.
- Notification système et son uniquement pour `needs_you`. Compteur dans le titre de l'onglet.
- Cliquer sur une carte ouvre la vue session : conversation en haut, Neovim en bas.

## Sécurité

Un projet voisin (CloudCLI) a eu une faille critique d'injection de commande via son shell WebSocket. Règles :
- Écoute sur `127.0.0.1` uniquement, jamais `0.0.0.0`.
- Jeton aléatoire généré au démarrage, exigé sur toutes les requêtes HTTP et WebSocket.
- Les endpoints de hooks vérifient aussi ce jeton.
- **Jeton (décidé)** : régénéré à chaque démarrage, jamais écrit sur le disque. Le serveur ouvre le navigateur sur `http://127.0.0.1:<port>/?token=…` ; il pose un cookie `HttpOnly; SameSite=Strict` puis redirige vers `/` (jeton absent de l'historique). Les WebSockets vérifient le cookie **et** l'en-tête `Origin`. Les hooks reçoivent le jeton dans leur URL, injectée via `--settings`.
- **Projets autorisés (décidé)** : liste fermée dans `%LOCALAPPDATA%\nvim-regie\config.json`, éditée à la main ; le serveur refuse tout chemin hors liste. Pas de sélecteur de dossier libre en v1.
- **Neovim (décidé)** : ta config habituelle + un fichier Lua du projet chargé en plus (`--cmd "source …"`) qui déclare le raccourci d'envoi (configurable) et le buffer de prompt. Pas de `-u`. Exécutable : `C:\Users\irpaui\Documents\Programmes\Neovim\bin\nvim.exe` (le `nvim.ps1` du PATH n'est qu'un relais), lancé directement par `node-pty`, chemin configurable dans `config.json`.
- **Fenêtre du serveur (décidé)** : console visible, fermer la fenêtre arrête tout ; le serveur ouvre le navigateur tout seul.
- **Définition de « fini » pour l'étape 1 (décidé)** : une session, un projet de `config.json`, `claude` affiché dans xterm.js, avec jeton, `Origin` et port fixe en place dès cette étape.
- **Port (décidé)** : fixe et configurable (par défaut 47600), pour un lancement et un marque-page stables.
- **Lancement (décidé)** : un raccourci sur le Bureau lance le serveur. Créé quand le serveur existe (étape 1), lancé à la main (pas un démarrage automatique : ne pas passer par `startupFolder`).
- Ne jamais construire de commande shell à partir de données reçues. `node-pty` et les processus sont lancés avec des tableaux d'arguments.
- Valider strictement les chemins (dossier de projet, id de session) avant de toucher au système de fichiers.

## Ordre de construction

Une étape à la fois, en mode Plan pour chacune, testée avant de passer à la suivante.

1. Serveur Node qui lance `claude` dans un pty et affiche le terminal brut dans le navigateur (xterm.js).
2. Documentation du format JSONL, puis affichage de la conversation rendue à partir du fichier.
3. Neovim dans le navigateur et pont RPC pour envoyer le prompt. ✅ Fait et validé à la main (voir `docs/etape3.md`).
4. Hooks HTTP et machine à états. ✅ Fait et validé à la main (voir `docs/etape4.md`).
5. Tableau de bord multi-sessions et reprise de session. ✅ Fait et validé à la main (voir `docs/etape5.md`, `docs/etape5b.md`).
6. Confort d'usage (voir `docs/etape6.md`).
7. Sessions multiples par dossier, puis chantiers en worktrees (D17).
8. Le reste selon les décisions ci-dessous.

## Projets similaires et ce qu'on en retient

Vérifier les licences avant de reprendre du code.

- **KyleAMathews/claude-code-ui** : tableau de bord kanban par statut à partir de `~/.claude/projects/`. Observation seulement. À lire pour la détection d'états depuis le JSONL.
- **vultuk/claude-code-web** : node-pty + WebSocket + xterm.js multi-sessions. À lire pour la gestion des pty.
- **siteboon/claudecodeui (CloudCLI)** : interface web complète. Leçon principale : la sécurité (voir plus haut).
- **tstapler/stapler-squad** : « mission control » multi-agents basé sur tmux, avec règles d'approbation.
- **xianxu/parley.nvim** : plugin de chat LLM où la conversation est un document Neovim éditable. Ce n'est pas un agent, mais source d'idées (voir décisions D9 et D10).

Notre différence : aucun de ces projets ne fait de Neovim la zone de saisie, avec la réponse visible pendant l'écriture et un tableau de bord qui pilote les sessions.

## Décisions à trancher

À passer au crible avec `/grill-me` avant de planifier. Chaque idée peut entrer dans la v1 ou être repoussée : c'est à décider. Mettre à jour cette section avec la décision prise et sa raison.

### Socle
- **D1. Nom du projet.** ✅ Décidé : `nvim-regie`. Vérification de disponibilité GitHub/npm reportée à une éventuelle publication.
- **D2. OS cibles.** ✅ Décidé : Windows 11 d'abord (poste de l'auteur, ConPTY), code portable (tableaux d'arguments, `path`, aucun chemin en dur), sans engagement macOS/Linux en v1.
- **D3. Stack front.** ✅ Décidé : HTML/JS en modules ES natifs, sans framework ni build ; xterm.js, `marked`, `highlight.js` servis en local depuis `node_modules` (pas de CDN). À revoir si le tableau de bord devient trop lourd.
- **D4. Licence.** ✅ Décidé : MIT (fichier `LICENSE` déjà présent).

### Fonctionnement
- **D5. Association pty ↔ fichier JSONL.** ✅ Décidé : `claude --session-id <uuid>` (vérifié sur 2.1.318). Le serveur génère l'UUID et suit `~/.claude/projects/<dossier-encodé>/<uuid>.jsonl`. À vérifier à la main : encodage du dossier sous Windows.
- **D6. Cycle de vie.** ✅ Décidé : fermer le navigateur ne tue rien (pty et `claude` vivent côté serveur). Au redémarrage du serveur, les pty meurent ; les projets réapparaissent « non lancé ». Pas de fichier d'UUID à nous : le serveur liste les JSONL que claude écrit (`src/sessions-list.js`, titre = dernier `ai-title`) et le bouton « Reprendre… » relance `claude --resume <uuid>` (même fichier complété, historique rejoué dans l'interface ; voir `docs/etape5b.md`). Rattacher un `claude` externe : impossible.
- **D7. Création des sessions.** ✅ Décidé : depuis l'interface uniquement (dossier choisi dans une liste de projets), sans détection des sessions externes. Worktrees : révisé par D17.
- **D17. Plusieurs sessions par dossier, chantiers en worktrees (étape 7).** ✅ Décidé (2026-11-06) :
  - Hiérarchie : Projet > Chantier (branche + worktree) > Sessions. Les sessions sont indexées par UUID, plus par projet.
  - Lot A : « + Session » dans un dossier déjà occupé, en mode *Consultation* (`--permission-mode plan`, lecture seule) ou *Écrivain* (avertissement si un écrivain existe déjà : chacun ne committe que ses fichiers). Étiquette libre optionnelle (« base », « code ») affichée sur la carte. Onglets des sessions sœurs dans la vue session.
  - Lot B : un chantier = un nom choisi par l'utilisateur, validé strictement, qui donne la branche et le worktree (`claude -w`). Le dossier principal reste sur `main` et sert aux fusions et suppressions.
  - Lot C : la carte d'un chantier affiche la note `chantiers\<branche>.md` si elle existe (lecture seule ; la régie ne déplace jamais les notes).
  - Raison : deux tâches couplées (code + base) partagent un worktree ; deux tâches indépendantes et longues prennent chacune le leur. Une branche sans worktree n'isole rien.
  - Vérifié sur 2.1.319 : `claude -w <nom>` crée `<projet>/.claude/worktrees/<nom>` sur la branche `worktree-<nom>` ; le JSONL va dans le dossier encodé du worktree ; le worktree reste `locked` après la sortie de `claude` ; `.claude/` apparaît non suivi dans le dépôt principal. Nettoyage à notre charge.
- **D8. Installation des hooks.** ✅ Décidé : injection par `claude --settings <JSON>` (option vérifiée) à chaque lancement ; `~/.claude/settings.json` n'est jamais modifié. À vérifier à l'étape 4 : fusion avec les hooks existants, pas remplacement.

### Idées à intégrer en v1 ou plus tard
- **D9. Le transcript dans Neovim.** ✅ v1 (étape 3) : dernière réponse seulement, en buffer lecture seule ouvrable en split ; conversation entière ensuite. Idée initiale : pousser toute la conversation (ou au moins la dernière réponse) dans un buffer Nvim en lecture seule, ouvrable en split, pour yanker avec mes motions. Idée inspirée de parley.nvim.
- **D10. Table des matières des échanges.** ⏸ Reportée (exige un transcript complet bien parsé). Sauter directement à la question n de la session, dans la vue web et dans le buffer.
- **D11. Autoriser depuis le tableau de bord.** ⏸ Reportée : en v1, `needs_you` ouvre la session et le tiroir terminal, on valide dans le vrai terminal. Bouton « Autoriser » sur la carte qui envoie la validation dans le pty. Pratique, mais risque d'accepter sans lire : limiter à certains outils ?
- **D12. Raccourcis clavier globaux.** ✅ v1 limitée : `j`/`k`/`Entrée`/`g n` sur le tableau de bord, page web seulement (pas de RPC depuis Neovim). Idée initiale : `g n` pour la prochaine session qui attend, `j`/`k`, `Entrée`. Utilisables aussi depuis Neovim via RPC ?
- **D13. Panneau de prévisualisation.** ⏸ Reporté (surface de sécurité : iframe). Afficher dans une iframe sandboxée les fichiers `.html`, `.svg` et `.md` que Claude écrit (repérés dans le JSONL via `Write`/`Edit`), et le serveur de dev (port lu dans `.claude/launch.json`).
- **D14. Auto-vérification visuelle.** ⏸ Reportée (navigateur piloté = surface de sécurité). Donner à Claude un navigateur (MCP Playwright ou Claude in Chrome) pour qu'il vérifie lui-même ses rendus.
- **D15. Autres agents.** ✅ Décidé : 100 % Claude Code, aucune abstraction prématurée. (Question initiale : prévoir dès le départ une abstraction pour Codex ou d'autres CLI, ou rester 100 % Claude Code ?
- **D16. Barre latérale compacte.** Garder le tableau de bord visible en version réduite pendant que je travaille dans une session.

## Conventions pour Claude

- Avant toute hypothèse sur le comportement de Claude Code (format JSONL, hooks, options CLI), vérifier sur la version installée ou dans la doc officielle, et noter ce qui a été vérifié.
- Petites étapes, chacune testable à la main en moins de cinq minutes.
- Pas de dépendance ajoutée sans la justifier.
