import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pty from 'node-pty';
import { TranscriptTail } from './transcript.js';
import { NvimBridge, pasteSequence } from './nvim.js';
import { cleanEnv } from './env.js';
import { readBranch } from './git.js';
import { initialState, next as nextState, markRead as markReadState, ptyExited, interrupted, isInterruptItem } from './state.js';

const MAX_EXCERPT = 200;
const MAX_STATUS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameFile = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const MAX_BUFFER = 200 * 1024;
const MAX_ITEMS = 5000;
const MAX_COLS = 500;
const MAX_ROWS = 200;

/** Texte de la dernière réponse : les blocs `text` assistant depuis le dernier message utilisateur. */
export function lastAnswer(items) {
  const parts = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'text') continue;
    if (it.role === 'user') break;
    parts.unshift(it.text);
  }
  return parts.join('\n\n');
}

const ENTER_DELAY_MS = 150;

function checkDim(n, max, nom) {
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${nom} invalide`);
}

export class Session {
  /** `resume` : id d'une session claude passée à reprendre (`--resume`) ; l'id des hooks (`this.id`) reste propre à ce pty. */
  constructor(project, spec, cols, rows, onChange = null, resume = undefined) {
    checkDim(cols, MAX_COLS, 'cols');
    checkDim(rows, MAX_ROWS, 'rows');
    if (resume !== undefined && (typeof resume !== 'string' || !UUID_RE.test(resume))) throw new TypeError('id de reprise invalide');
    this.project = project;
    this.spec = spec;
    this.onChange = onChange;
    this.id = randomUUID();
    this.claudeId = resume ?? this.id;
    this.snap = initialState();
    this.since = Date.now();
    this.excerpt = '';
    this.buffer = '';
    this.listeners = new Set();
    this.exited = false;
    this.exitCode = null;
    this.pty = pty.spawn(spec.command, spec.args(this.id, resume), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: project.path,
      env: cleanEnv(),
      useConpty: true,
      useConptyDll: true,
    });
    this.pty.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
      this.#emit({ type: 'data', data });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.#setSnap(ptyExited(this.snap));
      this.#emit({ type: 'exit', code: exitCode });
      // Laisse au suivi le temps de lire les dernières lignes écrites avant la sortie.
      if (this.tail) setTimeout(() => this.tail.stop(), 2000).unref();
    });
    this.items = [];
    this.pending = null;
    this.status = '';
    this.tail = null;
    this.answer = '';
    this.backlogSeen = false;
    this.bridge = null;
    this.nvimBuffer = '';
    this.nvimExit = null;
    this.nvimReady = Promise.resolve();
    if (spec.nvim) this.#startNvim(spec.nvim, cols, rows);
    if (spec.transcript) {
      this.tail = new TranscriptTail({
        resolve: () => spec.transcript.resolve(project, this.claudeId),
        intervalMs: spec.transcript.intervalMs,
        onItems: (batch) => {
          this.items.push(...batch);
          if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
          this.#confirmPending(batch);
          this.#emit({ type: 'transcript', items: batch });
          // Le premier lot lu d'un fichier est l'historique (reprise) : ses interruptions sont anciennes.
          if (this.backlogSeen) this.noteTranscriptItems(batch);
          this.backlogSeen = true;
          this.#pushAnswer();
        },
      });
      this.tail.start();
    }
  }

  #startNvim(spec, cols, rows) {
    try {
      this.bridge = new NvimBridge({
        ...spec,
        id: this.id,
        cols,
        rows,
        cwd: this.project.path,
        onSend: (text) => this.sendPrompt(text),
        onData: (data) => {
          this.nvimBuffer += data;
          if (this.nvimBuffer.length > MAX_BUFFER) this.nvimBuffer = this.nvimBuffer.slice(-MAX_BUFFER);
          this.#emit({ type: 'nvim-data', data });
        },
        onExit: (code) => {
          this.nvimExit = code;
          this.#emit({ type: 'nvim-exit', code });
        },
      });
    } catch (e) {
      this.#emit({ type: 'error', message: `nvim : ${e.message}` });
      return;
    }
    this.nvimReady = this.bridge.ready.then(
      () => this.#pushAnswer(true),
      (e) => this.#emit({ type: 'error', message: `nvim : ${e.message}` }),
    );
  }

  /**
   * Colle le prompt dans claude et l'affiche aussitôt (« pending ») sans attendre le JSONL,
   * qui est relu en mode rapide ; la ligne utilisateur du transcript remplace l'affichage provisoire.
   */
  sendPrompt(text) {
    if (this.exited || typeof text !== 'string') return;
    this.pty.write(pasteSequence(text));
    setTimeout(() => { if (!this.exited) this.pty.write('\r'); }, ENTER_DELAY_MS).unref();
    this.pending = text;
    this.#emit({ type: 'pending', text });
    if (this.tail) this.tail.kick();
  }

  #confirmPending(batch) {
    if (this.pending === null) return;
    if (batch.some((it) => it.kind === 'text' && it.role === 'user' && !isInterruptItem(it))) this.pending = null;
  }

  #pushAnswer(force = false) {
    const answer = lastAnswer(this.items);
    if (!this.bridge || (!force && answer === this.answer)) return;
    this.answer = answer;
    if (answer) this.bridge.setAnswer(answer).catch(() => {});
  }

  #emit(msg) {
    for (const fn of this.listeners) fn(msg);
  }

  #stateMsg() {
    return { type: 'state', state: this.snap.state, activity: this.snap.activity, since: this.since, excerpt: this.excerpt };
  }

  #setSnap(snap, excerpt) {
    if (snap === this.snap && excerpt === undefined) return;
    if (snap.state !== this.snap.state) this.since = Date.now();
    this.snap = snap;
    if (excerpt !== undefined) this.excerpt = excerpt;
    this.#emit(this.#stateMsg());
    if (this.onChange) this.onChange();
  }

  /** Applique un événement de hook (corps JSON déjà parsé, donc non fiable : tout est revalidé). */
  applyHook(payload) {
    if (!payload || typeof payload !== 'object') return;
    this.#followTranscript(payload.transcript_path);
    let excerpt;
    if (payload.hook_event_name === 'Stop') {
      excerpt = typeof payload.last_assistant_message === 'string'
        ? payload.last_assistant_message.trim().slice(0, MAX_EXCERPT) : '';
    } else if (payload.hook_event_name === 'UserPromptSubmit') {
      excerpt = '';
    }
    this.#setSnap(nextState(this.snap, payload), excerpt);
    // /clear et /resume : SessionStart n'existe pas en HTTP, SessionEnd arrive avec reason (mesuré).
    if (payload.hook_event_name === 'SessionEnd' && (payload.reason === 'clear' || payload.reason === 'resume')) {
      this.#resetConversation();
    }
  }

  /** Esc en plein tour : pas de hook, mais le transcript porte « [Request interrupted by user] ». */
  noteTranscriptItems(batch) {
    if (batch.some(isInterruptItem)) this.#setSnap(interrupted(this.snap));
  }

  #resetConversation() {
    this.items = [];
    this.pending = null;
    this.answer = '';
    this.#emit({ type: 'transcript-reset' });
  }

  /** Texte de la statusLine (relais) : affiché tel quel, séquences ANSI comprises, borné. */
  setStatus(text) {
    if (typeof text !== 'string') return;
    this.status = text.slice(0, MAX_STATUS);
    this.#emit({ type: 'status', text: this.status });
  }

  markRead() {
    this.#setSnap(markReadState(this.snap));
  }

  /** /clear et /resume changent l'id de session : le suivi du JSONL doit changer de fichier. */
  #followTranscript(given) {
    if (typeof given !== 'string' || !this.tail || !this.spec?.transcript?.accept) return;
    const file = this.spec.transcript.accept(given);
    if (!file || sameFile(file, this.tail.file)) return;
    this.tail.retarget(file);
    this.backlogSeen = false;
    this.#resetConversation();
  }

  subscribe(fn) {
    if (this.buffer) fn({ type: 'data', data: this.buffer });
    if (this.items.length) fn({ type: 'transcript', items: this.items });
    if (this.pending !== null) fn({ type: 'pending', text: this.pending });
    if (this.status) fn({ type: 'status', text: this.status });
    if (this.nvimBuffer) fn({ type: 'nvim-data', data: this.nvimBuffer });
    if (this.nvimExit !== null) fn({ type: 'nvim-exit', code: this.nvimExit });
    if (this.exited) fn({ type: 'exit', code: this.exitCode });
    fn(this.#stateMsg());
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  write(data) {
    if (typeof data !== 'string') throw new TypeError('data doit être une chaîne');
    if (!this.exited) this.pty.write(data);
  }

  /** Échap vers claude : interrompt le tour en cours, sans passer par le tiroir terminal. */
  interrupt() {
    if (!this.exited) this.pty.write('');
  }

  resize(cols, rows) {
    checkDim(cols, MAX_COLS, 'cols');
    checkDim(rows, MAX_ROWS, 'rows');
    if (!this.exited) this.pty.resize(cols, rows);
  }

  nvimWrite(data) {
    if (typeof data !== 'string') throw new TypeError('data doit être une chaîne');
    if (this.bridge) this.bridge.write(data);
  }

  nvimResize(cols, rows) {
    checkDim(cols, MAX_COLS, 'cols');
    checkDim(rows, MAX_ROWS, 'rows');
    if (this.bridge) this.bridge.resize(cols, rows);
  }

  kill() {
    if (this.bridge) this.bridge.kill();
    if (this.tail) this.tail.stop();
    // Même après la sortie : avec useConptyDll, node-pty ne ferme la pseudo-console qu'au kill().
    if (!this.released) {
      this.released = true;
      try { this.pty.kill(); } catch { /* déjà libéré */ }
    }
  }
}

export class SessionManager {
  /** @param {{command:string, args:(id:string)=>string[]}} spec */
  constructor(spec) {
    this.spec = spec;
    this.sessions = new Map();
    this.watchers = new Map(); // fn -> projets de la config
  }

  /** Résumé de chaque projet de la config (session vivante ou « stopped »), branche lue dans .git/HEAD. */
  summaries(projects = []) {
    const list = [];
    for (const p of projects) {
      const s = this.sessions.get(p.name);
      list.push({
        project: p.name,
        branch: readBranch(p.path),
        state: s ? s.snap.state : 'stopped',
        activity: s ? s.snap.activity : '',
        since: s ? s.since : null,
        excerpt: s ? s.excerpt : '',
      });
    }
    return list;
  }

  /** Flux global : fn reçoit {type:'sessions', sessions} tout de suite puis à chaque changement. */
  subscribeAll(fn, projects = []) {
    this.watchers.set(fn, projects);
    fn({ type: 'sessions', sessions: this.summaries(projects) });
    return () => this.watchers.delete(fn);
  }

  #notify() {
    for (const [fn, projects] of this.watchers) fn({ type: 'sessions', sessions: this.summaries(projects) });
  }

  start(project, cols, rows, { resume } = {}) {
    const existing = this.sessions.get(project.name);
    if (existing && !existing.exited) return existing;
    const s = new Session(project, this.spec, cols, rows, () => this.#notify(), resume);
    this.sessions.set(project.name, s);
    this.#notify();
    return s;
  }

  /** Tue la session vivante du projet (s'il y en a une) puis en démarre une autre, éventuellement en reprise. */
  restart(project, cols, rows, opts = {}) {
    const old = this.sessions.get(project.name);
    if (old) {
      this.sessions.delete(project.name);
      old.kill();
    }
    return this.start(project, cols, rows, opts);
  }

  /** Retrouve une session par son id (route des hooks). */
  byId(id) {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return null;
  }

  killAll() {
    for (const s of this.sessions.values()) s.kill();
  }
}
