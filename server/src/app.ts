import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { log } from './log.js';
import { HttpError } from './util/http.js';
import { authRoutes, currentUser } from './routes/auth.js';
import { mediaRoutes } from './routes/media.js';
import { downloadRoutes } from './routes/downloads.js';
import { fileRoutes } from './routes/files.js';
import { systemRoutes } from './routes/system.js';
import { settingsRoutes } from './routes/settings.js';
import { updateRoutes } from './routes/updates.js';
import { discoverRoutes } from './routes/discover.js';

const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/state', '/api/auth/login', '/api/auth/logout', '/api/auth/setup']);

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function findPublicDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.PUBLIC_DIR, path.join(here, '..', 'public'), path.join(here, '..', '..', 'web', 'dist')].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
}

/** Requests that change something must come from our own page (blocks CSRF from sibling subdomains too). */
function checkCsrf(req: FastifyRequest): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (req.headers['x-requested-with'] !== 'aio-arr') throw new HttpError('Missing request header', 403);
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpError('Bad origin', 403);
    }
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')]
      .map((h) => (h || '').trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length && !hosts.includes(originHost)) {
      throw new HttpError(
        `Request from ${originHost} blocked: it does not match this server (${hosts[0]}). If you use a reverse proxy, make sure it passes the original Host header.`,
        403,
      );
    }
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    // honour X-Forwarded-* only from reverse proxies on private networks (docker, LAN, localhost)
    trustProxy: process.env.TRUST_PROXY || 'loopback,linklocal,uniquelocal',
    bodyLimit: 5 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 2048 },
  });

  await app.register(cookie);
  await app.register(compress, { global: true, threshold: 2048, encodings: ['gzip', 'deflate'] });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!req.url.startsWith('/api/')) reply.header('Content-Security-Policy', CSP);
    else if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const route = req.url.split('?')[0].replace(/\/+$/, '');
    checkCsrf(req);
    if (PUBLIC_ROUTES.has(route)) return;
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Please sign in' });
    req.user = user;
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: unknown; code?: string };
    let status = err instanceof HttpError ? err.statusCode : e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') status = 415;
    if (status >= 500) log.error(`${req.method} ${req.url.split('?')[0]} failed:`, e.message);
    else log.debug(`${req.method} ${req.url.split('?')[0]} -> ${status}: ${e.message}`);
    reply.code(status).send({ error: status >= 500 && !(err instanceof HttpError) ? `Internal error: ${e.message}` : e.message });
  });

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(mediaRoutes);
  await app.register(downloadRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
  await app.register(updateRoutes);
  await app.register(discoverRoutes);

  const publicDir = findPublicDir();
  if (publicDir) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: true,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
    log.info(`Serving web UI from ${publicDir}`);
  } else {
    log.warn('Web UI build not found - only the API is available (run "npm run build" in web/)');
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !publicDir || req.method !== 'GET') {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Single page app: let the client router handle it
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html').sendFile('index.html');
  });

  return app;
}
