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

## Lot B : chantiers en worktrees (à faire)
Voir D17 dans `CLAUDE.md` : nom validé strictement → branche + worktree (`claude -w`), dossier principal sur `main`, nettoyage des worktrees à notre charge.

## Lot C : note de chantier sur la carte (à faire)
