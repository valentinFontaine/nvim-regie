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

## Mesures faites sur un vrai claude 2.1.318 (hooks HTTP journalisés)

- **/clear** : `SessionEnd` arrive ~1 s après avec `reason=clear` ; `SessionStart` n'arrive jamais en HTTP ;
  le `session_id` change au prompt suivant. → le serveur vide la conversation sur `SessionEnd` (clear/resume),
  sans attendre le prochain prompt.
- **Esc en plein tour** : **aucun hook** (ni `Stop`). Le badge restait « en cours ». Mais le JSONL reçoit une
  ligne user « [Request interrupted by user] » → `interrupted()` repasse running/needs_you à `idle`.
- Esc dans la page : le focus Neovim intercepte Esc ; le bouton « Interrompre » (header, actif seulement en « en cours ») envoie Échap au pty de claude sans ouvrir le tiroir.

## Validé à la main (2026-11-04)

- Esc dans le tiroir terminal : le badge doit repasser à « au repos ».
- /clear : l'affichage doit se vider tout de suite.
- Les hooks de `~/.claude/settings.json` tournent toujours (fusion, non rejoué).
