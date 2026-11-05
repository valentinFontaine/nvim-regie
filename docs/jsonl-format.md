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
| `api-request`, `api-request-blob`, `api-request-shape`, `queue-operation`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `atis-latch` | bruit interne, ignoré |

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
