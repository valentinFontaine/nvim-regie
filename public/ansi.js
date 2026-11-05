// Découpe un texte de terminal (sortie d'une statusLine) en segments colorés.
// Seules les séquences SGR (ESC[…m) de couleur de texte et de gras sont interprétées ;
// toute autre séquence d'échappement est retirée. Aucun HTML produit : l'appelant pose textContent.

const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'];
const BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const hex = (n) => n.toString(16).padStart(2, '0');

function color256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `#${hex(v[Math.floor(i / 36)])}${hex(v[Math.floor(i / 6) % 6])}${hex(v[i % 6])}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${hex(g)}${hex(g)}${hex(g)}`;
}

function applySgr(params, st) {
  const p = params === '' ? [0] : params.split(';').map((x) => Number(x) || 0);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) { st.color = null; st.bold = false; }
    else if (c === 1) st.bold = true;
    else if (c === 22) st.bold = false;
    else if (c === 39) st.color = null;
    else if (c >= 30 && c <= 37) st.color = BASIC[c - 30];
    else if (c >= 90 && c <= 97) st.color = BRIGHT[c - 90];
    else if (c === 38 && p[i + 1] === 5 && p[i + 2] <= 255) { st.color = color256(p[i + 2]); i += 2; }
    else if (c === 38 && p[i + 1] === 2) {
      const [r, g, b] = p.slice(i + 2, i + 5).map((x) => Math.min(255, x));
      st.color = `rgb(${r},${g},${b})`;
      i += 4;
    }
  }
}

/** @returns {{text:string, color:string|null, bold:boolean}[]} */
export function ansiSegments(input) {
  const s = String(input ?? '');
  const out = [];
  const st = { color: null, bold: false };
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
  let last = 0;
  let m;
  const push = (text) => {
    if (!text) return;
    const prev = out.at(-1);
    if (prev && prev.color === st.color && prev.bold === st.bold) prev.text += text;
    else out.push({ text, color: st.color, bold: st.bold });
  };
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    if (m[2] === 'm') applySgr(m[1], st);
    last = re.lastIndex;
  }
  push(s.slice(last));
  return out;
}
