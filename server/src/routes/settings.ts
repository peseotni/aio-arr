import type { FastifyInstance } from 'fastify';
import {
  CLIENT_IDS,
  CONTENT_TYPES,
  SERVICE_IDS,
  SERVICE_NAMES,
  getSettings,
  lockedPaths,
  maskedSettings,
  resolveServiceConfig,
  updateSettings,
  type ClientId,
  type ServiceId,
} from '../config.js';
import { createUser, deleteUser, listUsers, updateUser, type Role } from '../auth.js';
import { HttpError } from '../util/http.js';
import { createClient, createService, services } from '../services/registry.js';
import { discoverServices } from '../services/discovery.js';
import { JellyfinService } from '../services/jellyfin.js';
import { body, params, query, requireAdmin, str } from './util.js';
import { AUTO_ORDER, PLAYER_SUPPORT, playerFor } from '../domain/players.js';
import { docker } from '../services/docker.js';

/** For Settings > Open with: which apps can open each type, and what "automatic" picks right now. */
function openWithOptions() {
  const reg = services();
  const apps = Object.keys(PLAYER_SUPPORT) as (keyof typeof PLAYER_SUPPORT)[];
  return Object.fromEntries(
    CONTENT_TYPES.map((t) => {
      const auto = AUTO_ORDER[t].find((id) => !!reg[id]);
      return [
        t,
        {
          options: apps.filter((a) => PLAYER_SUPPORT[a].includes(t)).map((a) => ({ id: a, name: SERVICE_NAMES[a], connected: !!reg[a] })),
          auto: auto ? { id: auto, name: SERVICE_NAMES[auto] } : undefined,
          current: playerFor(t, reg),
        },
      ];
    }),
  );
}

const settingsResponse = () => ({ settings: maskedSettings(), locked: lockedPaths(), openWith: openWithOptions(), docker: !!docker() });

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // every route in this file is admin only
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/settings') || req.url.startsWith('/api/users')) requireAdmin(req);
  });

  app.get('/api/settings', async () => settingsResponse());

  app.put('/api/settings', async (req) => {
    updateSettings(body(req));
    return settingsResponse();
  });

  app.post('/api/settings/test', async (req) => {
    const b = body(req);
    const group = b.group === 'clients' ? 'clients' : 'services';
    const id = str(b.id, 'id');
    const valid = group === 'clients' ? (CLIENT_IDS as readonly string[]).includes(id) : (SERVICE_IDS as readonly string[]).includes(id);
    if (!valid) throw new HttpError('Unknown service', 400);
    const cfg = resolveServiceConfig(group, id, (b.config || {}) as Record<string, unknown>);
    if (!cfg.url) throw new HttpError('URL is required', 400);
    const svc = group === 'clients' ? createClient(id as ClientId, cfg) : createService(id as ServiceId, cfg);
    try {
      return await svc.test();
    } catch (err) {
      throw new HttpError(err instanceof Error ? err.message : String(err), 400);
    }
  });

  app.post('/api/settings/discover', async () => discoverServices());

  // Jellyfin / Emby: sign in once as an admin and create an API key for AIO Arr
  app.post('/api/settings/jellyfin-key', async (req) => {
    const b = body(req);
    const product = b.product === 'emby' ? 'Emby' : 'Jellyfin';
    const url = str(b.url, `${product} URL`).replace(/\/+$/, '');
    try {
      const apiKey = await JellyfinService.createApiKey(url, str(b.username, 'Username'), str(b.password, 'Password', { optional: true }), product);
      return { apiKey };
    } catch (err) {
      throw new HttpError(err instanceof Error ? err.message : String(err), 400);
    }
  });

  app.get('/api/settings/jellyfin-users', async (req) => {
    const jf = query(req).product === 'emby' ? services().emby : services().jellyfin;
    if (!jf) return [];
    const users = await jf.users();
    return users.map((u) => ({ id: u.Id as string, name: u.Name as string, admin: !!u.Policy?.IsAdministrator }));
  });

  app.get('/api/settings/paths-check', async () => {
    const fs = await import('node:fs/promises');
    const p = getSettings().paths;
    const check = async (path: string) => {
      if (!path) return { path, exists: false, writable: false };
      try {
        const st = await fs.stat(path);
        let writable = false;
        try {
          await fs.access(path, (await import('node:fs')).constants.W_OK);
          writable = true;
        } catch {
          /* read only */
        }
        return { path, exists: st.isDirectory(), writable };
      } catch {
        return { path, exists: false, writable: false };
      }
    };
    return {
      downloads: await Promise.all(p.downloads.map(check)),
      music: await check(p.music),
      audiobooks: await check(p.audiobooks),
      ebooks: await check(p.ebooks),
      comics: await check(p.comics),
    };
  });

  /* ---------------- users ---------------- */

  app.get('/api/users', async () => listUsers());

  app.post('/api/users', async (req) => {
    const b = body(req);
    const role: Role = b.role === 'admin' ? 'admin' : 'user';
    try {
      createUser(str(b.username, 'Username', { max: 64 }).trim(), str(b.password, 'Password', { max: 256 }), role);
    } catch (err) {
      throw new HttpError((err as Error).message, 400);
    }
    return listUsers();
  });

  app.put('/api/users/:username', async (req) => {
    const b = body(req);
    const changes: { password?: string; role?: Role } = {};
    if (typeof b.password === 'string' && b.password) changes.password = b.password;
    if (b.role === 'admin' || b.role === 'user') changes.role = b.role;
    try {
      updateUser(params(req).username, changes);
    } catch (err) {
      throw new HttpError((err as Error).message, 400);
    }
    return listUsers();
  });

  app.delete('/api/users/:username', async (req) => {
    const username = params(req).username;
    if (username.toLowerCase() === req.user?.username.toLowerCase()) throw new HttpError('You cannot delete your own account', 400);
    try {
      deleteUser(username);
    } catch (err) {
      throw new HttpError((err as Error).message, 400);
    }
    return listUsers();
  });
}
