// Rendu Markdown assaini. La sortie du modèle et des outils est NON FIABLE :
// tout HTML produit par marked passe par DOMPurify avant d'entrer dans le DOM.
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import hljs from '/vendor/highlight/core.js';

const LANGS = {
  javascript: ['javascript', ['js']], typescript: ['typescript', ['ts']], python: ['python', ['py']],
  bash: ['bash', ['sh', 'zsh']], shell: ['shell', []], json: ['json', []], xml: ['xml', ['html', 'svg']],
  css: ['css', []], powershell: ['powershell', ['ps1', 'pwsh']], sql: ['sql', []],
  markdown: ['markdown', ['md']], yaml: ['yaml', ['yml']], diff: ['diff', ['patch']],
  lua: ['lua', []], ini: ['ini', ['toml']], dos: ['dos', ['bat', 'cmd']],
};

await Promise.all(Object.entries(LANGS).map(async ([file, [name, aliases]]) => {
  const mod = await import(`/vendor/highlight/languages/${file}.js`);
  hljs.registerLanguage(name, mod.default);
  if (aliases.length) hljs.registerAliases(aliases, { languageName: name });
}));

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function highlightCode(code, lang) {
  const l = (lang || '').trim().split(/\s+/)[0];
  if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  return escapeHtml(code);
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      return `<pre><code class="hljs">${highlightCode(text, lang)}</code></pre>\n`;
    },
    // Lien Markdown vers un fichier local (`[app.js](src/app.js#L42)`) : DOMPurify en retirerait
    // la cible. On le garde comme référence de chemin, que app.js fait résoudre par le serveur.
    link({ href, tokens }) {
      if (typeof href !== 'string' || /^[a-z][a-z0-9+.-]+:/i.test(href) || href.startsWith('#')) return false;
      let target = href;
      try { target = decodeURI(href); } catch { /* garder tel quel */ }
      return `<code class="pathref" data-path="${escapeHtml(target)}">${this.parser.parseInline(tokens)}</code>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? ''), { async: false }), PURIFY_CONFIG);
}

/** Texte court « cible » d'un appel d'outil, pour le résumé replié. */
export function toolTarget(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  const s = typeof pick === 'string' ? pick : JSON.stringify(pick);
  return s.replace(/\s+/g, ' ').slice(0, 120);
}
