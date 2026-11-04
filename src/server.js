import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { SessionManager } from './session.js';
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
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
};

export function createApp({ config, token, sessions }) {
  const { port } = config;
  const server = http.createServer((req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
      res.end(body);
    };
    if (!hostAllowed(req.headers.host, port)) return send(403, 'Forbidden');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

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

    const file = PAGES[url.pathname] ?? VENDOR[url.pathname];
    if (!file) return send(404, 'Not Found');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'Not Found');
      send(200, data, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    });
  });

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

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return reply({ type: 'error', message: 'JSON invalide' }); }
      if (!msg || typeof msg !== 'object') return reply({ type: 'error', message: 'message invalide' });
      try {
        if (msg.type === 'start') {
          const project = config.projects.find((p) => p.name === msg.project);
          if (!project) return reply({ type: 'error', message: 'projet inconnu' });
          if (unsub) unsub();
          session = sessions.start(project, msg.cols, msg.rows);
          unsub = session.subscribe(reply);
        } else if (msg.type === 'input') {
          if (session) session.write(msg.data);
        } else if (msg.type === 'resize') {
          if (session) session.resize(msg.cols, msg.rows);
        } else {
          reply({ type: 'error', message: 'type inconnu' });
        }
      } catch (e) {
        reply({ type: 'error', message: e.message });
      }
    });
    ws.on('close', () => { if (unsub) unsub(); });
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
    args: (id) => ['--session-id', id],
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
