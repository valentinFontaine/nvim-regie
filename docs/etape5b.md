# Étape 5b — reprendre une session depuis l'interface

Avancé depuis D6 : sans reprise, l'interface était inutilisable (il fallait taper `/resume` dans le tiroir terminal).

## Mesure (claude 2.1.318)
- `claude --resume <uuid>` **réutilise l'id** et complète le même fichier JSONL (416 339 → 468 741 octets au test).
- Aucun menu bloquant ; l'historique arrive par `TranscriptTail` en ~600 ms ; les hooks portent le `session_id` d'origine.
- Les lignes `ai-title` (dernière = titre à jour) sont après ~250 Ko de boilerplate : le listing lit le fichier entier (cache mtime+size).

## Fonctionnement
- `src/sessions-list.js` : `listPastSessions(root, projet)` → `[{id,title,mtime,size}]`, plus récent d'abord. Ignore les fichiers sans vrai message utilisateur.
- WS : `list-sessions {project}` → `past-sessions` ; `resume {project,id,cols,rows}` (id validé : doit figurer dans le listing du projet ; la session vivante est remplacée).
- `Session.claudeId` (uuid repris) distinct de `Session.id` (route des hooks, socket nvim).
- Historique rejoué : l'interruption `[Request interrupted…]` n'est détectée que pour les lignes ajoutées après le premier rattrapage (`backlogSeen`).
- Interface : projet non lancé → clic → sélecteur (« Nouvelle session » + sessions passées) ; rien ne démarre avant le choix. Bouton « Reprendre… » dans la vue session (confirmation si `running`/`needs_you`).

## Reste / non fait
- Volume : rejeu du plus gros fichier (3,3 Mo) non mesuré dans le navigateur ; si lent, limiter aux N derniers messages.
- Hors périmètre : `--fork-session`, renommage/suppression, recherche.
