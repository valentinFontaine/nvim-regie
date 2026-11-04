# Étape 3 : Neovim dans le navigateur et pont d'envoi

## Fonctionnement
- Chaque session lance, en plus de `claude`, un `nvim` dans un second pty (`src/nvim.js`, `NvimBridge`), avec `--listen \\.\pipe\nvim-regie-<id-session>` et `--cmd "lua dofile(vim.env.REGIE_LUA)"`. Le chemin du Lua et la touche d'envoi passent par les variables d'environnement `REGIE_LUA` et `REGIE_SEND_KEY` : aucune commande n'est construite à partir de données reçues. Pas de `-u` : la config Neovim habituelle se charge.
- `nvim/regie.lua` (au `VimEnter`) crée un buffer de prompt `regie://prompt` (scratch, markdown) et un buffer `regie://reponse` (lecture seule). Touche d'envoi : `sendKey` de `config.json` (défaut `<leader><CR>`, modes n et i) ; `<leader>r` ouvre la dernière réponse en split.
- Le serveur se connecte au pipe avec le client npm `neovim` (MIT, 5.5.0), pose `g:regie_chan`, et écoute la notification `regie_send`.
- Envoi : lecture du buffer, **retrait de tout `\x1b`** (sinon un `\x1b[201~` collé fermerait le bracketed paste), écriture de `\x1b[200~…\x1b[201~` dans le pty de claude, puis `\r` 150 ms plus tard ; le buffer est ensuite vidé.
- D9 : à chaque lot du transcript, la dernière réponse (blocs `text` assistant depuis le dernier message utilisateur) est poussée dans `regie://reponse`.
- Protocole WebSocket ajouté : client → serveur `nvim-input`, `nvim-resize` ; serveur → client `nvim-data`, `nvim-exit` (rejeu du tampon à la reconnexion, comme pour claude).

## Config
`config.json` : `nvimPath` (chemin absolu, doit exister), `sendKey` (1 à 32 caractères).

## Sécurité
Le navigateur envoie des frappes à Neovim, qui peut lancer des commandes (`:!`). C'est le pouvoir d'un terminal local, protégé par le jeton, le cookie et le contrôle d'`Origin` (inchangés).

## Vérifié
- Tests Node avec le vrai `nvim.exe` (v0.11.4, `--clean`, touche `<F9>`) : envoi, vidage, ESC retiré, réponse en lecture seule, relais `nvim-data`, validation des messages WS.
- Piège : `nvim_feedkeys` en mode `x` ne déclenche pas le mapping via RPC dans les tests ; utiliser `nvim_input`. Fermer le socket avec `destroy()` provoque un `ERR_STREAM_PREMATURE_CLOSE` non géré ; `end()` non.

## À vérifier à la main (non testable sous Node)
Prompt multi-ligne accepté par le vrai `claude` via ConPTY (bracketed paste + `\r`), rendu de Neovim dans xterm.js avec la config utilisateur, `<leader>r`, rechargement de la page.

## Correctifs après essai manuel
- **Conversation vide** : un serveur lancé depuis un terminal héritant d'une session Claude Code (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`…) donne un `claude` qui affiche « Transcript saving is off » et n'écrit aucun JSONL. `src/env.js` (`cleanEnv`) retire ces marqueurs de l'environnement des pty `claude` et `nvim` (test dans `test/session.test.js`). Bracketed paste + `\r` mesuré avec le vrai `claude` : accepté.
- **Buffers Neovim** : le prompt est un buffer `nofile` (`:w` impossible, voulu) ; `regie://reponse` est en lecture seule. `<leader>r` bascule (ouvre/ferme), `q` ferme, barre d'indication dans chaque fenêtre.
