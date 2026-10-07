import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SESSION_COOKIE,
  authConfig,
  authenticateLocal,
  clearLoginFailures,
  createSessionToken,
  createUser,
  findUser,
  hasUsers,
  loginAllowed,
  recordLoginFailure,
  updateUser,
  verifyPassword,
  verifySessionToken,
  type SessionUser,
} from '../auth.js';
import { getSettings } from '../config.js';
import { JellyfinService } from '../services/jellyfin.js';
import { services } from '../services/registry.js';
import { HttpError } from '../util/http.js';
import { moduleLogger } from '../log.js';
import { body, str } from './util.js';

const log = moduleLogger('auth');

export function currentUser(req: FastifyRequest): SessionUser | null {
  if (authConfig.mode === 'none') return { username: 'admin', role: 'admin', source: 'none' };
  if (authConfig.mode === 'proxy') {
    const name = req.headers[authConfig.proxyHeader];
    const username = Array.isArray(name) ? name[0] : name;
    if (!username) return null;
    const isAdmin = !authConfig.proxyAdmins.length || authConfig.proxyAdmins.includes(username.toLowerCase());
    return { username, role: isAdmin ? 'admin' : 'user', source: 'proxy' };
  }
  return verifySessionToken(req.cookies?.[SESSION_COOKIE]);
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, user: SessionUser, remember: boolean): void {
  const days = user.source === 'jellyfin' ? Math.min(authConfig.sessionDays, 14) : authConfig.sessionDays;
  reply.setCookie(SESSION_COOKIE, createSessionToken(user, days), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: remember ? days * 86400 : undefined,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/state', async (req) => {
    const user = currentUser(req);
    const s = getSettings();
    return {
      authenticated: !!user,
      user: user ? { username: user.username, role: user.role, source: user.source } : undefined,
      authMode: authConfig.mode,
      setupRequired: authConfig.mode === 'local' && !hasUsers(),
      jellyfinLogin: s.general.jellyfinLogin !== 'off' && !!services().jellyfin,
      title: s.general.title,
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (authConfig.mode !== 'local') throw new HttpError('Sign-in is handled by your reverse proxy', 400);
    const ip = req.ip;
    if (!loginAllowed(ip)) throw new HttpError('Too many attempts. Try again in a few minutes.', 429);
    const b = body(req);
    const username = str(b.username, 'Username', { max: 128 }).trim();
    const password = str(b.password, 'Password', { max: 256 });
    const remember = b.remember !== false;

    let user = authenticateLocal(username, password);
    const jfMode = getSettings().general.jellyfinLogin;
    const jf = services().jellyfin;
    if (!user && jfMode !== 'off' && jf && !findUser(username)) {
      try {
        const res = await JellyfinService.authenticate(jf.baseUrl, username, password);
        const isAdmin = !!res?.User?.Policy?.IsAdministrator;
        if (jfMode === 'all' || isAdmin) {
          user = { username: res.User.Name, role: isAdmin ? 'admin' : 'user', source: 'jellyfin', jellyfinUserId: res.User.Id };
        }
      } catch (err) {
        log.debug('Jellyfin sign-in failed', (err as Error).message);
      }
    }
    if (!user) {
      recordLoginFailure(ip);
      log.warn(`Failed sign-in for "${username.slice(0, 64)}" from ${ip}`);
      await new Promise((r) => setTimeout(r, 400));
      throw new HttpError('Wrong username or password', 401);
    }
    clearLoginFailures(ip);
    setSessionCookie(req, reply, user, remember);
    return { ok: true, user: { username: user.username, role: user.role, source: user.source } };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (authConfig.mode !== 'local') throw new HttpError('Not available in this auth mode', 400);
    if (hasUsers()) throw new HttpError('Setup has already been completed', 409);
    const b = body(req);
    const username = str(b.username, 'Username', { max: 64 }).trim();
    const password = str(b.password, 'Password', { max: 256 });
    createUser(username, password, 'admin');
    log.info(`Created first admin account "${username}"`);
    const user: SessionUser = { username, role: 'admin', source: 'local' };
    setSessionCookie(req, reply, user, true);
    return { ok: true, user };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const me = req.user;
    if (!me || me.source !== 'local') throw new HttpError('Only local accounts can change their password here', 400);
    const b = body(req);
    const current = str(b.current, 'Current password');
    const next = str(b.password, 'New password');
    const rec = findUser(me.username);
    if (!rec || !verifyPassword(current, rec.hash)) throw new HttpError('Current password is wrong', 400);
    updateUser(me.username, { password: next });
    setSessionCookie(req, reply, me, true);
    return { ok: true };
  });
}
