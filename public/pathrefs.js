// Chemins cités par l'agent → liens. Le client ne fait que repérer des candidats ; c'est le serveur
// qui résout (dans le dossier de la session), classe, et re-vérifie tout à chaque action.

const MAX_LEN = 500;
const LOOKS_LIKE_PATH = /[\\/]|\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?|#L\d+)?$/;
const NVIM_KINDS = new Set(['html', 'svg', 'dir']); // logo N : l'action par défaut n'est pas Neovim

function candidateText(code) {
  const t = (code.dataset.path ?? code.textContent).trim();
  if (!t || t.length > MAX_LEN || /\s/.test(t) || !LOOKS_LIKE_PATH.test(t)) return null;
  return t;
}

export function createPathRefs({ send, el, sessionId, focusNvim, preview }) {
  let cache = new Map();   // texte -> { abs, kind } ou null (non résolu)
  let waiting = new Map(); // texte -> Set<code> en attente de la réponse
  // Requêtes en vol, dans l'ordre d'envoi (le WebSocket garde l'ordre) : textes demandés, ou null
  // si la requête concernait la session précédente (réponse à ignorer).
  let inflight = [];

  function act(type, text) {
    send({ type, path: text });
  }

  function onClick(text, info) {
    if (info.kind === 'text') { act('open-file', text); focusNvim(); }
    else if (info.kind === 'image' || info.kind === 'svg') {
      preview(`/api/file?session=${encodeURIComponent(sessionId())}&path=${encodeURIComponent(text)}`, info.abs);
    }
    else if (info.kind === 'html' || info.kind === 'doc' || info.kind === 'dir') act('os-open', text);
    else act('reveal', text);
  }

  function decorate(code, text, info) {
    if (code.dataset.linked) return;
    code.dataset.linked = '1';
    code.classList.add('pathref', 'linked', `k-${info.kind}`);
    code.title = info.kind === 'text' ? `${info.abs}\n(clic : ouvrir dans Neovim)` : info.abs;
    code.tabIndex = 0;
    code.onclick = (e) => { e.preventDefault(); onClick(text, info); };
    code.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onClick(text, info); } };
    const tools = el('span', 'pathref-tools');
    if (NVIM_KINDS.has(info.kind)) {
      const n = el('button', 'pathref-n', 'N');
      n.type = 'button';
      n.title = 'Ouvrir dans Neovim (nouvel onglet)';
      n.onclick = () => { act('open-file', text); focusNvim(); };
      tools.append(n);
    }
    const copy = el('button', 'pathref-copy', '📋');
    copy.type = 'button';
    copy.title = `Copier le chemin absolu : ${info.abs}`;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(info.abs); copy.textContent = '✓'; }
      catch { copy.textContent = '✗'; }
      setTimeout(() => { copy.textContent = '📋'; }, 1200);
    };
    tools.append(copy);
    code.after(tools);
  }

  return {
    /** Repère les chemins d'un bloc Markdown rendu et demande leur résolution (groupée). */
    scan(root) {
      const ask = [];
      for (const code of root.querySelectorAll('code')) {
        // `[`app.js`](src/app.js)` donne un code dans un code : seul l'extérieur (data-path) compte.
        if (code.closest('pre') || code.dataset.linked || code.parentElement?.closest('code')) continue;
        const text = candidateText(code);
        if (!text) continue;
        if (cache.has(text)) {
          const info = cache.get(text);
          if (info) decorate(code, text, info);
          continue;
        }
        if (!waiting.has(text)) { waiting.set(text, new Set()); ask.push(text); }
        waiting.get(text).add(code);
      }
      for (let i = 0; i < ask.length; i += 200) {
        const batch = ask.slice(i, i + 200);
        inflight.push(batch);
        send({ type: 'resolve-paths', paths: batch });
      }
    },

    /** Réponse `paths-resolved` du serveur (même ordre que les requêtes). */
    resolved(items) {
      const batch = inflight.shift();
      if (!batch) return; // requête de l'ancienne session, ou réponse inattendue
      for (const text of batch) {
        const info = items?.[text];
        const ok = info && typeof info.abs === 'string' && typeof info.kind === 'string' ? info : null;
        cache.set(text, ok);
        for (const code of waiting.get(text) ?? []) if (ok && code.isConnected) decorate(code, text, ok);
        waiting.delete(text);
      }
    },

    /** Changement de session : tout ce qui est en vol concerne l'ancien dossier. */
    reset() {
      cache = new Map();
      waiting = new Map();
      inflight = inflight.map(() => null);
    },
  };
}
