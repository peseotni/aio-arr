/*
 * Single sign-on for the whole stack: you log in to AIO Arr once, the server talks to
 * every service with its API key. Supports local accounts, Jellyfin accounts, a trusted
 * reverse-proxy header (Authelia/Authentik) or no auth at all (LAN only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { configPath, ensureConfigDir } from './config.js';
import { JsonStore } from './store.js';
import { moduleLogger } from './log.js';

const log = moduleLogger('auth');

export type Role = 'admin' | 'user';
export type AuthMode = 'local' | 'none' | 'proxy';

export interface UserRecord {
  username: string;
  hash: string;
  role: Role;
  createdAt: string;
  tokenVersion: number;
}

export interface SessionUser {
  username: string;
  role: Role;
  source: 'local' | 'jellyfin' | 'proxy' | 'none';
  jellyfinUserId?: string;
}

interface SessionPayload {
  u: string;
  r: Role;
  s: SessionUser['source'];
  v?: number;
  j?: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = 'aio_session';

export const authConfig = {
  mode: ((): AuthMode => {
    const m = (process.env.AUTH_MODE || 'local').toLowerCase();
    return m === 'none' || m === 'proxy' ? m : 'local';
  })(),
  proxyHeader: (process.env.AUTH_PROXY_HEADER || 'remote-user').toLowerCase(),
  proxyAdmins: (process.env.AUTH_PROXY_ADMINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS) || 30),
};

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

const store = new JsonStore<{ users: UserRecord[] }>('users.json', () => ({ users: [] }));

export const USERNAME_RE = /^[a-zA-Z0-9._@-]{2,64}$/;

export function listUsers(): Omit<UserRecord, 'hash' | 'tokenVersion'>[] {
  return store.read().users.map(({ username, role, createdAt }) => ({ username, role, createdAt }));
}

export function hasUsers(): boolean {
  return store.read().users.length > 0;
}

export function findUser(username: string): UserRecord | undefined {
  const lc = username.toLowerCase();
  return store.read().users.find((u) => u.username.toLowerCase() === lc);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  try {
    const actual = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (password.length > 256) throw new Error('Password is too long');
  return password;
}

export function createUser(username: string, password: string, role: Role): void {
  if (!USERNAME_RE.test(username)) throw new Error('Username may only contain letters, numbers and . _ @ - (2-64 chars)');
  validatePassword(password);
  if (findUser(username)) throw new Error('A user with that name already exists');
  store.update((d) => {
    d.users.push({ username, hash: hashPassword(password), role, createdAt: new Date().toISOString(), tokenVersion: 1 });
  });
}

export function updateUser(username: string, changes: { password?: string; role?: Role }): void {
  const existing = findUser(username);
  if (!existing) throw new Error('User not found');
  if (changes.role && changes.role !== 'admin' && existing.role === 'admin') {
    const admins = store.read().users.filter((u) => u.role === 'admin');
    if (admins.length <= 1) throw new Error('At least one admin account is required');
  }
  store.update((d) => {
    const u = d.users.find((x) => x.username === existing.username)!;
    if (changes.password !== undefined) {
      u.hash = hashPassword(validatePassword(changes.password));
      u.tokenVersion += 1; // log out other sessions
    }
    if (changes.role) {
      u.role = changes.role;
      u.tokenVersion += 1;
    }
  });
}

export function deleteUser(username: string): void {
  const existing = findUser(username);
  if (!existing) throw new Error('User not found');
  if (existing.role === 'admin' && store.read().users.filter((u) => u.role === 'admin').length <= 1) {
    throw new Error('Cannot delete the last admin account');
  }
  store.update((d) => {
    d.users = d.users.filter((u) => u.username !== existing.username);
  });
}

/** Create / refresh the admin account defined by ADMIN_USERNAME / ADMIN_PASSWORD. */
export function bootstrapAdminFromEnv(): void {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;
  if (password.length < 8) {
    log.warn('ADMIN_PASSWORD must be at least 8 characters - ignoring it');
    return;
  }
  if (password === 'change-me-please') {
    log.error('ADMIN_PASSWORD is still the example value from .env.example - set your own password. The admin account was NOT created/updated.');
    return;
  }
  const existing = findUser(username);
  if (!existing) {
    createUser(username, password, 'admin');
    log.info(`Created admin account "${username}" from environment`);
  } else if (!verifyPassword(password, existing.hash) || existing.role !== 'admin') {
    store.update((d) => {
      const u = d.users.find((x) => x.username === existing.username)!;
      u.hash = hashPassword(password);
      u.role = 'admin';
      u.tokenVersion += 1;
    });
    log.info(`Updated admin account "${username}" from environment`);
  }
}

export function authenticateLocal(username: string, password: string): SessionUser | null {
  const user = findUser(username);
  if (!user) {
    // burn comparable CPU time so usernames can't be probed via timing
    verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64'));
    return null;
  }
  if (!verifyPassword(password, user.hash)) return null;
  return { username: user.username, role: user.role, source: 'local' };
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

let secret: Buffer | undefined;

function getSecret(): Buffer {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) {
    secret = crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
    return secret;
  }
  const file = configPath('session.key');
  try {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (buf.length >= 32) {
      secret = buf;
      return secret;
    }
  } catch {
    /* create below */
  }
  ensureConfigDir();
  secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function createSessionToken(user: SessionUser, days = authConfig.sessionDays): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    u: user.username,
    r: user.role,
    s: user.source,
    iat: now,
    exp: now + days * 86400,
  };
  if (user.source === 'local') payload.v = findUser(user.username)?.tokenVersion ?? 1;
  if (user.jellyfinUserId) payload.j = user.jellyfinUserId;
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | undefined): SessionUser | null {
  if (!token || token.length > 4096) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now() / 1000) return null;
  if (payload.s === 'local') {
    const u = findUser(payload.u);
    if (!u || u.tokenVersion !== payload.v) return null;
    return { username: u.username, role: u.role, source: 'local' };
  }
  if (payload.s === 'jellyfin') {
    return { username: payload.u, role: payload.r, source: 'jellyfin', jellyfinUserId: payload.j };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Login rate limiting                                                 */
/* ------------------------------------------------------------------ */

const attempts = new Map<string, { count: number; reset: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  if (!a || a.reset < Date.now()) return true;
  return a.count < MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + WINDOW_MS });
  else a.count += 1;
  if (attempts.size > 10000) {
    for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  }
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}
