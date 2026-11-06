import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { SessionManager, claudeArgs } from './session.js';
import { findTranscript, defaultProjectsRoot, acceptTranscript } from './transcript.js';
import { listPastSessions } from './sessions-list.js';
import { listChantiers, createChantier, removeChantier, cleanChantierName } from './chantiers.js';
import {
  COOKIE_NAME, createToken, tokenMatches, parseCookies, originAllowed, hostAllowed,
} from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

// Liste fermée des fichiers servis hors de public/.
const VENDOR = {
  '/vendor/xterm/lib/xterm.js': path.join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm/css/xterm.css': path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit/lib/addon-fit.js': path.join(ROOT, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
};
const PAGES = {
  '/': path.join(PUBLIC, 'index.html'),
  '/app.js': path.join(PUBLIC, 'app.js'),
  '/render.js': path.join(PUBLIC, 'render.js'),
  '/dashboard.js': path.join(PUBLIC, 'dashboard.js'),
  '/ansi.js': path.join(PUBLIC, 'ansi.js'),
};
// Dossiers servis par préfixe : un seul niveau de nom de fichier sûr par segment, extension imposée.
const VENDOR_DIRS = [
  { prefix: '/vendor/marked/', dir: path.join(ROOT, 'node_modules/marked/lib'), ext: /\.js$/ },
  { prefix: '/vendor/dompurify/', dir: path.join(ROOT, 'node_modules/dompurify/dist'), ext: /\.mjs$/ },
  { prefix: '/vendor/highlight/languages/', dir: path.join(ROOT, 'node_modules/highlight.js/es/languages'), ext: /\.js$/ },
  { prefix: '/vendor/highlight/styles/', dir: path.join(ROOT, 'node_modules/highlight.js/styles'), ext: /\.css$/ },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOOK_ROUTE = /^\/(hooks|status)\/([0-9a-f]{64})\/([^/]+)$/i;
const RELAY = path.join(ROOT, 'scripts', 'statusline-relay.mjs');
const MAX_HOOK_BODY = 64 * 1024;
const HOOK_EVENTS = [
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse' },
  { name: 'PostToolUse' },
  { name: 'Notification', matcher: 'permission_prompt' },
  { name: 'Stop' },
  { name: 'SessionEnd' },
];

/**
 * Contenu de `--settings` : un hook HTTP par événement, jeton et id de session dans l'URL, et une
 * statusLine relais qui exécute celle de l'utilisateur puis poste son texte au serveur. Jamais écrit sur disque.
 * La commande n'est faite que de valeurs du serveur (chemins, port, jeton hexadécimal, UUID).
 */
export function hooksSettings(port, token, id) {
  const url = `http://127.0.0.1:${port}/hooks/${token}/${id}`;
  const hooks = {};
  for (const { name, matcher } of HOOK_EVENTS) {
    hooks[name] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'http', url, timeout: 5 }] }];
  }
  const q = (p) => `"${p.replaceAll('\\', '/')}"`;
  const statusLine = { type: 'command', command: `${q(process.execPath)} ${q(RELAY)} ${port} ${token} ${id}` };
  // showThinkingSummaries (défaut false sur 2.1.318) : sans lui, les blocs thinking du JSONL sont vides.
  return JSON.stringify({ hooks, statusLine, showThinkingSummaries: true });
}

const SAFE_SEGMENT =/^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function resolveVendorDir(pathname) {
  for (const v of VENDOR_DIRS) {
    if (!pathname.startsWith(v.prefix)) continue;
    const segments = pathname.slice(v.prefix.length).split('/');
    if (!segments.every((s) => SAFE_SEGMENT.test(s) && !s.includes('..'))) return null;
    if (!v.ext.test(segments.at(-1))) return null;
    const full = path.resolve(v.dir, ...segments);
    return full.startsWith(v.dir + path.sep) ? full : null;
  }
  return null;
}
// highlight.js 11 ne livre son cœur qu'en CommonJS : on l'enveloppe en module ES à la volée
// (aucun `require`, vérifié), sans étape de build.
const HLJS_CORE = path.join(ROOT, 'node_modules/highlight.js/lib/core.js');
const HLJS_SHIM_HEAD = 'const module = { exports: {} }; const exports = module.exports;\n';
const HLJS_SHIM_TAIL = '\nexport default module.exports;\n';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
};

export function createApp({
  config, token, sessions,
  pastSessions = (project) => listPastSessions(defaultProjectsRoot(), project.path),
  chantiers = { list: listChantiers, create: createChantier, remove: removeChantier },
}) {
  const { port } = config;
  const server = http.createServer((req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
      res.end(body);
    };
    if (!hostAllowed(req.headers.host, port)) return send(403, 'Forbidden');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    const hook = HOOK_ROUTE.exec(url.pathname);
    if (hook) return handleHook(req, send, hook[2], hook[3], hook[1].toLowerCase() === 'status' ? applyStatus : applyHook);

    if (req.method !== 'GET') return send(405, 'Method Not Allowed');

    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!tokenMatches(url.searchParams.get('token'), token)) return send(401, 'Unauthorized');
      return send(302, '', {
        Location: '/',
        'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!tokenMatches(cookies[COOKIE_NAME], token)) return send(401, 'Unauthorized');

    if (url.pathname === '/api/projects') {
      return send(200, JSON.stringify(config.projects.map((p) => ({ name: p.name }))), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }

    if (url.pathname === '/vendor/highlight/core.js') {
      return fs.readFile(HLJS_CORE, 'utf8', (err, src) => {
        if (err) return send(404, 'Not Found');
        send(200, HLJS_SHIM_HEAD + src + HLJS_SHIM_TAIL, { 'Content-Type': TYPES['.js'] });
      });
    }
    const file = PAGES[url.pathname] ?? VENDOR[url.pathname] ?? resolveVendorDir(url.pathname);
    if (!file) return send(404, 'Not Found');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'Not Found');
      send(200, data, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    });
  });

  // Hooks de Claude Code : pas de cookie (c'est `claude` qui appelle), le jeton est dans l'URL.
  const applyHook = (session, payload) => { session.applyHook(payload); return true; };
  const applyStatus = (session, payload) => {
    if (typeof payload?.text !== 'string') return false;
    session.setStatus(payload.text);
    return true;
  };

  // Même porte pour les hooks et la statusLine relais : jeton dans l'URL, corps JSON borné.
  function handleHook(req, send, given, id, apply) {
    if (!tokenMatches(given, token)) return send(401, 'Unauthorized');
    if (req.method !== 'POST') return send(405, 'Method Not Allowed');
    const session = UUID_RE.test(id) ? sessions.byId(id) : null;
    if (!session) return send(404, 'Not Found');
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_HOOK_BODY) {
        aborted = true;
        send(413, 'Payload Too Large', { Connection: 'close' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, 'Bad Request'); }
      let ok = true;
      try { ok = apply(session, payload); } catch { /* un hook mal formé ne doit jamais faire tomber le serveur */ }
      send(ok ? 204 : 400, '');
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const cookies = parseCookies(req.headers.cookie);
    const ok = url.pathname === '/ws'
      && hostAllowed(req.headers.host, port)
      && originAllowed(req.headers.origin, port)
      && tokenMatches(cookies[COOKIE_NAME], token);
    if (!ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws));
  });

  function handleSocket(ws) {
    let session = null;
    let unsub = null;
    const reply = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    // Flux global (tableau de bord) : dès la connexion, sans start.
    const unsubAll = sessions.subscribeAll(reply, config.projects);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return reply({ type: 'error', message: 'JSON invalide' }); }
      if (!msg || typeof msg !== 'object') return reply({ type: 'error', message: 'message invalide' });
      const findProject = () => config.projects.find((p) => p.name === msg.project);
      // Lieu = projet de la config + chantier listé par le serveur : jamais un chemin reçu du client.
      const findPlace = () => {
        const project = findProject();
        if (!project) return { error: 'projet inconnu' };
        if (msg.chantier === undefined || msg.chantier === null) return { place: { ...project, chantier: null } };
        if (typeof msg.chantier !== 'string') return { error: 'chantier inconnu' };
        const c = chantiers.list(project).find((x) => x.name === msg.chantier);
        if (!c) return { error: 'chantier inconnu' };
        return { place: { name: project.name, path: c.path, chantier: c.name } };
      };
      const attach = (s) => {
        if (unsub) unsub();
        session = s;
        unsub = s.subscribe(reply);
      };
      try {
        if (msg.type === 'start') {
          const { place, error } = findPlace();
          if (error) return reply({ type: 'error', message: error });
          const s = sessions.start(place, msg.cols, msg.rows, { mode: msg.mode ?? 'write', label: msg.label });
          reply({ type: 'started', id: s.id });
          attach(s);
        } else if (msg.type === 'attach') {
          const s = sessions.get(msg.id);
          if (!s) return reply({ type: 'error', message: 'session inconnue' });
          attach(s);
        } else if (msg.type === 'list-sessions') {
          const { place, error } = findPlace();
          if (error) return reply({ type: 'error', message: error });
          const list = pastSessions(place).map((x) => ({ ...x, open: sessions.byClaudeId(x.id)?.id ?? null }));
          reply({ type: 'past-sessions', project: place.name, chantier: place.chantier, sessions: list });
        } else if (msg.type === 'resume') {
          // Reprise : l'id doit figurer dans le listing du projet (donc être un fichier de ce projet).
          const { place, error } = findPlace();
          if (error) return reply({ type: 'error', message: error });
          if (typeof msg.id !== 'string' || !pastSessions(place).some((x) => x.id === msg.id.toLowerCase())) {
            return reply({ type: 'error', message: 'session inconnue' });
          }
          // `replace` : la session affichée, du même projet, est fermée et remplacée (bouton « Reprendre… »).
          let old = null;
          if (msg.replace !== undefined) {
            old = sessions.get(msg.replace);
            if (!old || old.project.name !== place.name || old.chantier !== place.chantier) return reply({ type: 'error', message: 'session à remplacer inconnue' });
          }
          // Jamais deux claude sur le même JSONL : on rouvre celle qui le suit déjà.
          const open = sessions.byClaudeId(msg.id);
          if (open) {
            reply({ type: 'started', id: open.id });
            return attach(open);
          }
          const opts = { resume: msg.id.toLowerCase(), mode: msg.mode ?? old?.mode ?? 'write', label: msg.label ?? old?.label };
          if (old) {
            if (unsub && session === old) { unsub(); unsub = null; session = null; }
            sessions.close(old.id);
          }
          const s = sessions.start(place, msg.cols, msg.rows, opts);
          reply({ type: 'started', id: s.id });
          attach(s);
        } else if (msg.type === 'create-chantier') {
          const project = findProject();
          if (!project) return reply({ type: 'error', message: 'projet inconnu' });
          const name = cleanChantierName(msg.name);
          Promise.resolve()
            .then(() => chantiers.create(project, name))
            .then(() => {
              reply({ type: 'chantier-created', project: project.name, chantier: name });
              sessions.refresh();
            })
            .catch((e) => reply({ type: 'error', message: e.message }));
        } else if (msg.type === 'remove-chantier') {
          const project = findProject();
          if (!project) return reply({ type: 'error', message: 'projet inconnu' });
          const c = typeof msg.chantier === 'string' ? chantiers.list(project).find((x) => x.name === msg.chantier) : null;
          if (!c) return reply({ type: 'error', message: 'chantier inconnu' });
          Promise.resolve()
            .then(() => chantiers.remove(project, c.name, { hasLiveSession: sessions.liveIn(project.name, c.name) }))
            .then(() => {
              reply({ type: 'chantier-removed', project: project.name, chantier: c.name });
              sessions.refresh();
            })
            .catch((e) => reply({ type: 'error', message: e.message }));
        } else if (msg.type === 'close') {
          if (session && session.id === msg.id) { if (unsub) unsub(); unsub = null; session = null; }
          if (!sessions.close(msg.id)) reply({ type: 'error', message: 'session inconnue' });
        } else if (msg.type === 'detach') {
          if (unsub) unsub();
          unsub = null;
          session = null;
        } else if (msg.type === 'read') {
          if (session) session.markRead();
        } else if (msg.type === 'interrupt') {
          if (session) session.interrupt();
        } else if (msg.type === 'input') {
          if (session) session.write(msg.data);
        } else if (msg.type === 'resize') {
          if (session) session.resize(msg.cols, msg.rows);
        } else if (msg.type === 'nvim-input') {
          if (session) session.nvimWrite(msg.data);
        } else if (msg.type === 'nvim-resize') {
          if (session) session.nvimResize(msg.cols, msg.rows);
        } else {
          reply({ type: 'error', message: 'type inconnu' });
        }
      } catch (e) {
        reply({ type: 'error', message: e.message });
      }
    });
    ws.on('close', () => { if (unsub) unsub(); unsubAll(); });
  }

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }),
    close: () => new Promise((resolve) => {
      for (const c of wss.clients) c.terminate();
      sessions.killAll();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function resolveClaude() {
  const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => /\.(exe|cmd)$/i.test(l.trim())) : null;
  if (!first) throw new Error('`claude` introuvable dans le PATH');
  return first.trim();
}

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const claude = resolveClaude();
  const token = createToken();
  const sessions = new SessionManager({
    command: claude,
    args: (id, resume, mode) => claudeArgs(id, resume, mode, hooksSettings(config.port, token, id)),
    nvim: { path: config.nvimPath, lua: path.join(ROOT, 'nvim', 'regie.lua'), sendKey: config.sendKey },
    listChantiers,
    transcript: {
      resolve: (project, id) => findTranscript(defaultProjectsRoot(), project.path, id),
      // Un transcript_path reçu d'un hook n'est suivi que s'il est un .jsonl sous la racine des projets.
      accept: (p) => acceptTranscript(defaultProjectsRoot(), p),
    },
  });
  const app = createApp({ config, token, sessions });
  await app.listen();
  const url = `http://127.0.0.1:${config.port}/?token=${token}`;
  console.log(`nvim-regie : http://127.0.0.1:${config.port}/ (claude : ${claude})`);
  console.log('Fermer cette fenêtre arrête tout.');
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
