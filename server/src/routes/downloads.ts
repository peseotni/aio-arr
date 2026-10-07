import type { FastifyInstance } from 'fastify';
import { ARR_IDS } from '../config.js';
import { HttpError } from '../util/http.js';
import { invalidate } from '../util/cache.js';
import { getClient, need, services } from '../services/registry.js';
import { getDownloads } from '../domain/downloads.js';
import { SEARCH_CATEGORIES, clearFinishedGrabs, grab, grabViews, indexerSearch, removeGrab, retryGrab } from '../domain/grabs.js';
import type { ArrService, GrabKind } from '../types.js';
import { body, bool, int, params, query, requireAdmin, str } from './util.js';

const GRAB_KINDS: GrabKind[] = ['music', 'audiobook', 'files'];

function grabKind(v: unknown): GrabKind | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!GRAB_KINDS.includes(v as GrabKind)) throw new HttpError('Unknown download type', 400);
  return v as GrabKind;
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/downloads', async () => getDownloads());

  app.post('/api/downloads/:client/:id/:action', async (req) => {
    const p = params(req);
    const c = getClient(p.client);
    if (p.action === 'pause') await c.pause(p.id);
    else if (p.action === 'resume') await c.resume(p.id);
    else throw new HttpError('Unknown action', 404);
    invalidate('downloads');
    return { ok: true };
  });

  app.delete('/api/downloads/:client/:id', async (req) => {
    const p = params(req);
    const deleteFiles = bool(query(req).deleteFiles);
    if (deleteFiles) requireAdmin(req);
    await getClient(p.client).remove(p.id, deleteFiles);
    invalidate('downloads');
    return { ok: true };
  });

  // Remove from an *arr queue, optionally blocklisting the release (the *arr then searches for another one)
  app.delete('/api/queue/:service/:id', async (req) => {
    requireAdmin(req); // the *arr app deletes the downloaded data too
    const p = params(req);
    const q = query(req);
    if (!(ARR_IDS as readonly string[]).includes(p.service)) throw new HttpError('Unknown service', 404);
    const svc = services()[p.service as ArrService];
    if (!svc) throw new HttpError('Service not configured', 404);
    await svc.removeQueueItem(int(p.id, 'id'), {
      removeFromClient: q.removeFromClient !== 'false',
      blocklist: bool(q.blocklist),
      skipRedownload: bool(q.skipRedownload),
    });
    invalidate('downloads');
    return { ok: true };
  });

  app.post('/api/clients/:client/:action', async (req) => {
    const p = params(req);
    const c = getClient(p.client);
    switch (p.action) {
      case 'altspeed':
        await c.setAltSpeed(bool(body(req).enabled));
        break;
      case 'pause-all':
        await c.pauseAll();
        break;
      case 'resume-all':
        await c.resumeAll();
        break;
      default:
        throw new HttpError('Unknown action', 404);
    }
    invalidate('downloads');
    return { ok: true };
  });

  /* ---------------- indexer search & direct grabs ---------------- */

  app.get('/api/indexers/categories', async () =>
    Object.entries(SEARCH_CATEGORIES).map(([id, c]) => ({ id, label: c.label })),
  );

  app.get('/api/indexers/search', async (req) => {
    const q = query(req);
    const term = str(q.q, 'Search term', { max: 200 }).trim();
    const cat = q.cat && SEARCH_CATEGORIES[q.cat] ? q.cat : 'all';
    return indexerSearch(term, cat);
  });

  app.post('/api/indexers/grab', async (req) => {
    const b = body(req);
    return grab(str(b.guid, 'guid', { max: 2048 }), int(b.indexerId, 'indexerId'), grabKind(b.kind), req.user?.username);
  });

  app.get('/api/indexers/status', async () => {
    const prowlarr = need(services().prowlarr, 'Prowlarr');
    const [indexers, status] = await Promise.all([prowlarr.indexers(), prowlarr.indexerStatus().catch(() => [])]);
    const failing = new Map(status.map((s) => [s.indexerId, s]));
    return indexers.map((i) => ({
      id: i.id,
      name: i.name,
      enabled: !!i.enable,
      protocol: i.protocol,
      privacy: i.privacy,
      disabledTill: failing.get(i.id)?.disabledTill,
      failing: !!failing.get(i.id)?.disabledTill && Date.parse(failing.get(i.id)!.disabledTill) > Date.now(),
    }));
  });

  app.get('/api/grabs', async () => grabViews());

  app.post('/api/grabs/:id/retry', async (req) => retryGrab(params(req).id, grabKind(body(req).kind)));

  app.delete('/api/grabs/:id', async (req) => {
    removeGrab(params(req).id);
    return { ok: true };
  });

  app.post('/api/grabs/clear', async () => {
    clearFinishedGrabs();
    return { ok: true };
  });
}
