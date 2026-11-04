# Étape 4 — hooks HTTP et machine à états

## Ce qui a été vérifié (claude 2.1.318, doc code.claude.com/docs/en/hooks)

- Hooks `type:"http"` : POST JSON ; serveur injoignable = erreur non bloquante. Test de fumée réel
  (`claude -p` dans un pty ConPTY, `--settings` en JSON inline) : le quoting Windows passe, les hooks arrivent.
- Champs reçus (observés) : `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, plus
  `prompt` (UserPromptSubmit), `last_assistant_message` (Stop), `reason` (SessionEnd).
- `--settings` fusionne les hooks avec ceux de `~/.claude/settings.json` (doc, non rejoué ici) : D8 confirmé.
- **`SessionStart` n'accepte pas les hooks HTTP.** `/clear` et `/resume` sont donc détectés par le
  `transcript_path` de n'importe quel événement : s'il change, le suivi du JSONL bascule (message `transcript-reset`).

## Table des événements (`src/state.js`)

| Événement | État |
|---|---|
| `UserPromptSubmit` | `running` |
| `PreToolUse` | `running` + activité « outil cible » |
| `PostToolUse` | `needs_you` → `running`, sinon inchangé |
| `Notification` (matcher `permission_prompt`) | `needs_you` |
| `Stop` | `done_unread` (+ extrait de `last_assistant_message`, 200 car.) |
| `SessionEnd` | `idle` |
| mort du pty | `error` (collant) |
| ouverture de la session (message WS `read`) | `done_unread` → `idle` |

## Sécurité

- Route `POST /hooks/<jeton>/<id-session>` : pas de cookie (c'est `claude` qui appelle). Jeton comparé en temps
  constant, Host vérifié, id = UUID d'une session connue, corps ≤ 64 Ko, réponse 204 immédiate.
- Le jeton n'existe que dans l'URL passée en argument à `claude` (jamais sur disque).
- `transcript_path` reçu n'est suivi que s'il est `<racine des projets>/<dossier>/<uuid>.jsonl` (`acceptTranscript`).

## À vérifier à la main (non établi par la doc)

- `Stop` se déclenche-t-il sur Esc en plein tour ? Sinon la session resterait `running`.
- `/clear` puis un prompt : la conversation suit-elle le nouveau fichier ?
- Les hooks de `~/.claude/settings.json` tournent toujours (fusion).
