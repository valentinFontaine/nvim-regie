import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'regie';

export function createToken() {
  return randomBytes(32).toString('hex');
}

export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function originAllowed(origin, port) {
  return origin === `http://127.0.0.1:${port}`;
}

export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}`;
}
