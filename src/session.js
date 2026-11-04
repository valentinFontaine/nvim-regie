import { randomUUID } from 'node:crypto';
import pty from 'node-pty';

const MAX_BUFFER = 200 * 1024;
const MAX_COLS = 500;
const MAX_ROWS = 200;

function checkDim(n, max, nom) {
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${nom} invalide`);
}

export class Session {
  constructor(project, spec, cols, rows) {
    checkDim(cols, MAX_COLS, 'cols');
    checkDim(rows, MAX_ROWS, 'rows');
    this.project = project;
    this.id = randomUUID();
    this.buffer = '';
    this.listeners = new Set();
    this.exited = false;
    this.exitCode = null;
    this.pty = pty.spawn(spec.command, spec.args(this.id), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: project.path,
      env: process.env,
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
      this.#emit({ type: 'exit', code: exitCode });
    });
  }

  #emit(msg) {
    for (const fn of this.listeners) fn(msg);
  }

  subscribe(fn) {
    if (this.buffer) fn({ type: 'data', data: this.buffer });
    if (this.exited) fn({ type: 'exit', code: this.exitCode });
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  write(data) {
    if (typeof data !== 'string') throw new TypeError('data doit être une chaîne');
    if (!this.exited) this.pty.write(data);
  }

  resize(cols, rows) {
    checkDim(cols, MAX_COLS, 'cols');
    checkDim(rows, MAX_ROWS, 'rows');
    if (!this.exited) this.pty.resize(cols, rows);
  }

  kill() {
    if (!this.exited) {
      try { this.pty.kill(); } catch { /* déjà mort */ }
    }
  }
}

export class SessionManager {
  /** @param {{command:string, args:(id:string)=>string[]}} spec */
  constructor(spec) {
    this.spec = spec;
    this.sessions = new Map();
  }

  start(project, cols, rows) {
    const existing = this.sessions.get(project.name);
    if (existing && !existing.exited) return existing;
    const s = new Session(project, this.spec, cols, rows);
    this.sessions.set(project.name, s);
    return s;
  }

  killAll() {
    for (const s of this.sessions.values()) s.kill();
  }
}
