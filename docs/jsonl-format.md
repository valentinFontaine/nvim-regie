# Format JSONL des sessions Claude Code (observé)

Format **interne et non documenté** : ce fichier décrit ce qui a été **observé** sur `claude` **2.1.318**
(Windows 11, ~1 640 lignes d'un vrai transcript + les transcripts locaux, 0 ligne invalide).
Les exemples sont synthétiques. Le parseur (`src/transcript.js`) ignore tout ce qu'il ne connaît pas.

## Emplacement
`~/.claude/projects/<dossier-encodé>/<session-id>.jsonl`, une ligne JSON par entrée.
- Encodage du dossier : tout caractère hors `[A-Za-z0-9]` devient `-`
  (`C:\Users\x\perso\nvim-regie` → `C--Users-x-perso-nvim-regie` ; `\.claude` → `--claude`).
  `findTranscript` essaie ce dossier, puis cherche `*/<uuid>.jsonl` si l'encodage diverge.
- Le fichier **n'existe qu'après le premier prompt** : le suivi tolère son absence.
- `claude --session-id <uuid>` (D5) fixe l'identifiant, donc le nom du fichier.

## Types de ligne (champ `type`)
| type | traitement |
|---|---|
| `user` | affiché (voir ci-dessous) |
| `assistant` | affiché, regroupé par `message.id` |
| `attachment`, `system/*` (`turn_duration`, `stop_hook_summary`, `compact_boundary`, `away_summary`) | ignoré en étape 2 |
| `api-request`, `api-request-blob`, `api-request-shape`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `atis-latch` | bruit interne, ignoré |

Champs communs : `uuid`, `parentUuid`, `timestamp` (ISO), `sessionId`, `cwd`, `gitBranch`, `version`,
`isSidechain`, `isMeta`.

## Pièges
- **Un message assistant = plusieurs lignes** (une par bloc `thinking`, `text`, `tool_use`) avec le
  même `message.id` (265 lignes pour 120 ids). Regrouper par `message.id`.
- `user.message.content` est une **chaîne ou un tableau de blocs**.
- Les résultats d'outils arrivent dans des lignes `user` : bloc `{type:"tool_result", tool_use_id, content, is_error?}`.
  `content` est une chaîne ou un tableau de blocs `text`, `image`, `document`, `tool_reference`.
- `isMeta: true` (injections système, ~18 % des lignes `user`) : écarté.
- `isSidechain: true` (sous-agents) : écarté en v1.
- `isCompactSummary`, `isVisibleInTranscriptOnly`, `origin.kind` (`"human"`…) existent ; non exploités.
- Les blocs `thinking` ont souvent un texte vide : écartés si vides. Cause (vérifiée dans le binaire
  2.1.318) : le réglage `showThinkingSummaries` vaut `false` par défaut (affichage « omitted »). La régie
  l'injecte à `true` via `--settings` pour ses sessions, ce qui demande des résumés de réflexion à l'API
  (équivalent CLI : `--thinking-display summarized`). Une session reprise ne récupère pas le texte des
  tours écrits avant.
- `message.stop_reason` : `tool_use` ou `end_turn` sur les lignes assistant.

## Exemples (synthétiques)
```json
{"type":"user","uuid":"u1","timestamp":"2026-01-01T10:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"Bonjour"}}
{"type":"assistant","uuid":"a1","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Je regarde."}]}}
{"type":"assistant","uuid":"a2","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.txt"}}]}}
{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"contenu"}]}}
```

## Règles de tolérance du parseur
- Ligne vide ou JSON invalide → ignorée. Valeur non-objet → ignorée.
- Type, bloc ou champ inconnu → ignoré, jamais d'exception.
- Dernière ligne incomplète (écriture en cours) → gardée en réserve jusqu'au passage suivant ;
  découpage sur l'octet `0x0A` avant décodage UTF-8.
- Fichier tronqué (taille < décalage) → relecture depuis le début.
- Bornes : résultat d'outil ≤ 20 000 caractères, chaque chaîne d'entrée d'outil ≤ 4 000 ;
  images et documents remplacés par `[image]` / `[document]`.

## Items normalisés poussés au navigateur
`{msgId, role, ts, kind:'text'|'thinking'|'tool_use'|'tool_result', …}`
- `text`/`thinking` : `text` ; `tool_use` : `toolUseId`, `name`, `input` ; `tool_result` : `toolUseId`, `text`, `isError`.
- Le navigateur regroupe par `msgId` et rattache `tool_result` à son `tool_use` par `toolUseId`.

## Tâches de fond (Bash `run_in_background`)

Mesuré le 2026-11-12 sur les transcripts de SRMix (≈ 20 tâches, 2 fichiers). Le tour de claude se termine (`Stop`)
pendant que la tâche tourne : la régie suit donc les tâches elle-même (`src/state.js`, `trackBg`).

| Moment | Ligne | Champs utiles |
|---|---|---|
| Lancement | `assistant` / `tool_use` `Bash` | `input.run_in_background === true`, `input.command` |
| Résultat immédiat | `user` / `tool_result` | champ de ligne `toolUseResult.backgroundTaskId` (ex. `buzsci941`) ; le texte donne aussi le fichier de sortie |
| Fin | `user`, `origin.kind === "task-notification"` | texte `<task-notification><task-id>…</task-id>…<status>completed\|failed</status>…` ; **relance un tour** de l'assistant |
| Arrêt manuel | `assistant` / `tool_use` `TaskStop` | `input.task_id` ; **aucune notification** en retour |

- La notification peut arriver en plein tour (entre un `tool_use` et son `tool_result`).
- Se fier à `origin.kind`, pas à `turnOrigin: "task_notification"` : ce dernier apparaît aussi sur un résumé de compaction.
- **Fin fiable : `queue-operation` avec `operation === "enqueue"`** et `content` = le même texte `<task-notification>…`. Toute notification passe par là (mesuré le 2026-11-26 sur 9 transcripts cad-illustrator : 57 tâches, 44 fermées ainsi et les 13 autres par `TaskStop`, aucune restée ouverte). Le message `user` ci-dessus **manque** quand la tâche finit pendant que claude travaille : la notification reste en file puis arrive en `attachment/queued_command`. `toItems` en tire un item `task-end` ; les autres `queue-operation` (`remove`, `dequeue`) et `queued_command` sont ignorés.
- Non établi : valeur `killed` de `status` ; comportement à la fermeture de la session avec des tâches ouvertes ;
  si un hook part au réveil par notification (la régie n'en dépend pas).

## Lancements détachés (`nohup … &` dans un Bash ordinaire)

Constaté le 2026-11-12 (SRMix) : un agent lance un long calcul par `nohup python -I -u render_scenes.py > log 2>&1 &`
dans un Bash au premier plan (pas de `run_in_background`). Le transcript ne contient alors **aucune** tâche de fond :
le `Stop` arrive, et le processus survit, orphelin (son `bash` parent est mort) : il n'est **pas** un descendant du
pty de `claude`, donc l'arbre de processus ne le voit pas.

Détection croisée (`src/detached.js`, `src/procs.js`, `trackBg`, `Session#probeDetached`) :
- le transcript dit *quoi* : `detachedTarget(command)` repère `nohup`, un `&` final, `Start-Process`, `start /b` et en tire
  le nom de fichier lancé (`render_scenes.py`) ; la tâche s'ouvre dès le `tool_result` (id `d:<toolUseId>`) ;
- les processus disent *jusqu'à quand* : toutes les 10 s (seulement si une tâche détachée est ouverte, après 15 s de grâce),
  une sonde PowerShell/CIM cherche un processus vivant dont la ligne de commande contient la cible. Absent → la tâche
  se ferme ; si la session était tenue « en cours » par le `Stop`, elle passe `done_unread` (aucune notification ne
  réveille l'agent pour un processus détaché).

Limites assumées : commande détachée sans nom de fichier reconnaissable (`nohup sleep 100 &`) non détectée ; un autre
processus de la machine portant le même nom de fichier prolonge la tâche à tort (badge orange après 2 min) ; sonde
impossible (hors Windows, délai) = tâche laissée ouverte.
