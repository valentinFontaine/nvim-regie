# Étape 7 — sessions multiples par dossier, chantiers en worktrees (D17)

## Lot A : plusieurs sessions dans un même dossier ✅ (validé à la main, 2026-11-06)

### Serveur
- Les sessions sont indexées par leur UUID (celui des hooks), plus par projet. `SessionManager.start` crée toujours une nouvelle session ; `get(id)`, `close(id)`, `byClaudeId(cid)`.
- Une carte par session (vivante, ou sortie tant qu'elle n'est pas fermée) ; une carte « stopped » (`key = p:<projet>`, `id = null`) pour un projet sans session.
- Modes : `write` (Écrivain, défaut) ou `consult` (Consultation : `claude --permission-mode plan`, lecture seule). `claudeArgs(id, resume, mode, settings)` construit les arguments.
- Étiquette libre (« base », « code ») : affichage seulement, mais bornée (24 caractères, lettres, chiffres, espace, `._-`) par `cleanLabel`.
- Messages WebSocket : `start {project, mode, label}`, `attach {id}`, `resume {project, id, mode?, label?, replace?}`, `close {id}` ; le serveur répond `started {id}`.
- Jamais deux `claude` sur le même JSONL : `resume` d'une session déjà suivie par une session vivante rouvre celle-ci. `claudeId` suit le fichier réellement écrit (retarget par le hook).
- `list-sessions` marque chaque session passée `open` (id de la session vivante qui la suit, sinon `null`).

### Interface
- Adresses : `#/s/<id>` (une session), `#/p/<projet>` (choix : nouvelle session ou reprise ; rien ne démarre avant).
- « + Session » : formulaire mode + étiquette, avertissement en ligne si un écrivain vit déjà dans le dossier (chacun ne committe que ses fichiers). « Annuler » ramène à la session de départ.
- « Fermer » : tue `claude` et Neovim, retire la carte ; le transcript reste, la session peut être reprise.
- « Reprendre… » : remplace la session affichée (même mode et étiquette par défaut).
- Onglets des sessions sœurs dans l'en-tête, colorés selon l'état. Cartes et notifications portent l'étiquette ou le mode.
- Clavier du tableau de bord (`j`/`k`/`g n`/Entrée) par carte (`key`).

### Défaut corrigé pendant la validation
- Reprise sans effet depuis la page d'un projet : `s.open === currentId` valait `null === null`, le clic fermait le sélecteur. Décision sortie dans `pastSessionAction` (`public/dashboard.js`), test de régression vu rouge.
- Outil de diagnostic utilisé : vrai serveur + faux `claude` (`node -e 'setInterval…'`) piloté dans Chrome headless par CDP (script jetable, hors dépôt).

## Lot B : chantiers en worktrees ✅ (validé à la main, 2026-11-10)
D17 révisée (2026-11-06) : `git worktree add` plutôt que `claude -w`. La branche porte le nom exact du chantier (cohérent avec `chantiers\<branche>.md` du lot C), et toutes les sessions du chantier tournent dans le worktree.

### Serveur
- `src/chantiers.js` :
  - Nom validé par `^[a-z0-9]+(-[a-z0-9]+)*$`, 40 caractères au plus ; `main`, `master` et `head` sont refusés.
  - Emplacement : `<projet>/.claude/worktrees/<nom>`. La ligne `.claude/worktrees/` est ajoutée une seule fois à `.git/info/exclude`.
  - Création : `git worktree add -b <nom> <chemin> HEAD`, donc depuis la branche courante du dossier principal.
  - Listing sans git : les sous-dossiers qui ont un `.git`, avec la branche lue par `readBranch`. Les worktrees faits par `claude -w` apparaissent aussi.
  - Clôture refusée s'il reste une session vivante, si `status --porcelain` n'est pas vide (fichiers non suivis compris) ou si `merge-base --is-ancestor <branche> HEAD` échoue. Sinon : `worktree remove`, puis `branch -d`. Jamais de `--force`.
  - Défaut vu à l'essai manuel (2026-11-10) : un programme resté dans le worktree (terminal, explorateur) verrouille le dossier sous Windows. `worktree remove` efface alors le contenu et désenregistre le worktree, puis échoue sur le dossier, et la branche restait. Corrigé : si le `.git` du worktree a disparu, on fait `worktree prune` puis `branch -d`, et on renvoie `leftover`. L'interface signale le dossier vide à supprimer à la main. Test : un processus enfant dont le dossier courant est le worktree (Windows seulement).
  - git est lancé par `execFile`, avec un tableau d'arguments.
- Un **lieu** `{name, path, chantier}` remplace le projet passé à `Session`. Le cwd de claude et de nvim, le transcript (dossier encodé du worktree) et la reprise suivent tout seuls.
- WebSocket :
  - `start`, `list-sessions` et `resume` acceptent `chantier`. Il doit figurer dans la liste du serveur : le serveur ne reçoit jamais de chemin du client.
  - `resume … replace` exige le même projet et le même chantier.
  - Nouveaux messages : `create-chantier` → `chantier-created` et `remove-chantier` → `chantier-removed`. Le flux global est renotifié ensuite.
- Cartes :
  - un lieu vide donne une carte `stopped`, de clé `p:<projet>` ou `c:<projet>/<chantier>` ;
  - chaque carte porte `chantier`, avec `null` pour le dossier principal.

### Interface
- Routes : `#/p/<projet>/<chantier>`. Titre des cartes : « projet › chantier ».
- Les onglets sœurs et l'avertissement « écrivain » sont limités au lieu.
- Sélecteur du dossier principal : « Nouveau chantier (depuis <branche>) », avec un avertissement si la branche n'est pas `main` ou `master`. Le chantier créé s'ouvre sur son sélecteur.
- Sélecteur d'un chantier : « Clore le chantier » avec `confirm()`. Si le serveur refuse, son message s'affiche tel quel.

## Lot C : note de chantier sur la carte (fait, à valider à la main)

- Fichier lu : `<notesDir>\<dossier du projet>\chantiers\<branche>.md` (`/` → `-`), lecture seule. `notesDir` est une clé optionnelle de `config.json` (défaut : `notes_Claude` d'OneDrive). Absent ou introuvable : pas de note, pas d'erreur.
- `src/notes.js` : `noteFile` valide la branche (`[\w.-]`, ni `..` ni séparateur) et vérifie que le chemin reste sous `notesDir` ; `readNote` plafonne à 100 Ko ; `noteExcerpt` garde « Objectif » et « Prochaine commande » du gabarit (sinon le début, 300 caractères).
- Carte d'un chantier : champ `note` (extrait) dans `summaries`, jamais pour le dossier principal. Le texte complet vient de `GET /api/note?project=&chantier=` (cookie exigé ; projet et chantier doivent exister, 404 sinon) et s'affiche en Markdown assaini. L'état déplié survit aux mises à jour de la grille.
- Les notes sont relues à chaque mise à jour du flux (quelques lectures de petits fichiers par chantier).
- Reliquats du lot B réglés ici : bouton « Clore le chantier » aussi dans la barre de la vue session ; refus « non fusionnée » qui nomme la branche du chantier et celle où fusionner, et explique que squash/rebase n'est pas reconnu.

## Ajout d'un dossier depuis l'interface (fait, à valider à la main)

La liste des projets reste fermée (`config.json`), mais elle s'alimente depuis l'interface, en choisissant parmi les dossiers où `claude` a déjà été lancé.
- `src/candidates.js` : clés de `projects` dans `~/.claude.json` (vrais chemins, `/` normalisés en `\`). Écartés : chemins disparus ou non-dossiers, worktrees (`.claude\worktrees`), dossiers sous `os.tmpdir()` (scratchpads inclus), dossiers déjà suivis (casse ignorée). Nom proposé = dernier segment, caractères hors `[\w .-]` remplacés, suffixe « 2 », « 3 » si pris.
- `src/config.js` : `validateProject` (extrait de `validateConfig`) et `addProject` : relit `config.json`, valide, n'ajoute que dans `projects` (autres clés conservées), écriture atomique (fichier temporaire + rename).
- WebSocket : `list-candidates` → `candidates` ; `add-project {path}` → `project-added`. Le client ne désigne qu'un chemin : le serveur le retrouve dans SA liste recalculée, sinon « dossier non proposé ». Le nom est celui du serveur. Le projet est ajouté au tableau `config.projects` existant (les abonnés du flux global le gardent par référence), puis le flux est renotifié : pas de redémarrage.
- Interface : bouton « + Dossier » (tableau de bord), dialogue de liste, puis confirmation (nom + chemin) avant l'écriture.
- Limite : un dossier ajouté à chaud n'est retiré qu'en éditant `config.json` à la main.
