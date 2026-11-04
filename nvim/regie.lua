-- Chargé par `nvim --cmd "lua dofile(vim.env.REGIE_LUA)"` : buffer de prompt + buffer de réponse.
-- Touche d'envoi : REGIE_SEND_KEY (défaut <leader><CR>). Le serveur pose vim.g.regie_chan.

local send_key = vim.env.REGIE_SEND_KEY
if not send_key or send_key == '' then send_key = '<leader><CR>' end

local function setup()
  local prompt = vim.api.nvim_create_buf(true, true)
  vim.bo[prompt].buftype = 'nofile'
  vim.bo[prompt].bufhidden = 'hide'
  vim.bo[prompt].swapfile = false
  vim.bo[prompt].filetype = 'markdown'
  vim.api.nvim_buf_set_name(prompt, 'regie://prompt')
  vim.api.nvim_set_current_buf(prompt)

  local answer = vim.api.nvim_create_buf(true, true)
  vim.bo[answer].buftype = 'nofile'
  vim.bo[answer].bufhidden = 'hide'
  vim.bo[answer].swapfile = false
  vim.bo[answer].filetype = 'markdown'
  vim.api.nvim_buf_set_name(answer, 'regie://reponse')
  vim.bo[answer].modifiable = false

  vim.g.regie_prompt_buf = prompt
  vim.g.regie_answer_buf = answer

  vim.keymap.set({ 'n', 'i' }, send_key, function()
    if vim.g.regie_chan then vim.rpcnotify(vim.g.regie_chan, 'regie_send') end
  end, { desc = 'nvim-regie : envoyer le prompt' })

  local prompt_win = vim.api.nvim_get_current_win()
  vim.wo[prompt_win].winbar = ' Prompt : ' .. send_key .. ' envoie à Claude (pas de :w, rien à sauvegarder)'

  -- Bascule : ouvre la dernière réponse (lecture seule) en split, ou la ferme si elle est déjà ouverte.
  local function toggle_answer()
    for _, w in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(w) == answer then
        vim.api.nvim_win_close(w, true)
        return
      end
    end
    vim.cmd('botright split')
    vim.api.nvim_win_set_buf(0, answer)
    vim.wo.winbar = ' Réponse de Claude (lecture seule) : y copie, q ou <leader>r ferme'
  end
  vim.keymap.set('n', '<leader>r', toggle_answer, { desc = 'nvim-regie : dernière réponse de Claude' })
  vim.keymap.set('n', 'q', toggle_answer, { buffer = answer, desc = 'nvim-regie : fermer la réponse' })

  vim.cmd('startinsert')
end

-- Appelé par le serveur à chaque nouvelle réponse.
function _G.regie_set_answer(lines)
  local buf = vim.g.regie_answer_buf
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].modified = false
end

-- Appelé par le serveur après envoi : vide le buffer de prompt.
function _G.regie_clear_prompt()
  vim.api.nvim_buf_set_lines(vim.g.regie_prompt_buf, 0, -1, false, {})
end

function _G.regie_get_prompt()
  return vim.api.nvim_buf_get_lines(vim.g.regie_prompt_buf, 0, -1, false)
end

vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = setup })
