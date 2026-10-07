import type { FastifyInstance } from 'fastify';
import { ARR_IDS } from '../config.js';
import { HttpError } from '../util/http.js';
import { services } from '../services/registry.js';
import {
  addMedia,
  addOptions,
  artistDetail,
  bookDetail,
  deleteMedia,
  grabArrRelease,
  listLibrary,
  movieDetail,
  releasesFor,
  searchAll,
  searchNow,
  seriesDetail,
  setMonitored,
  type AddRequest,
} from '../domain/library.js';
import { discover } from '../domain/overview.js';
import type { ArrService } from '../types.js';
import { body, bool, int, intList, optInt, params, query, requireAdmin, str } from './util.js';

const KINDS = ['movie', 'series', 'artist', 'album', 'book'] as const;
type Kind = (typeof KINDS)[number];

function kind(v: string): Kind {
  if (!(KINDS as readonly string[]).includes(v)) throw new HttpError(`Unknown media type "${v}"`, 404);
  return v as Kind;
}

function arrService(v: string): ArrService {
  if (!(ARR_IDS as readonly string[]).includes(v)) throw new HttpError(`Unknown service "${v}"`, 404);
  return v as ArrService;
}

const ARTWORK_PATH = /^(?:(?:artist|album|author|book)\/)?\d+\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/;

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (req) => {
    const q = query(req);
    const term = str(q.q, 'Search term', { max: 200 }).trim();
    const kinds = (q.kinds || '').split(',').filter(Boolean);
    return searchAll(term, kinds);
  });

  app.get('/api/library/:kind', async (req) => listLibrary(kind(params(req).kind)));

  app.get('/api/library/:kind/:id', async (req) => {
    const p = params(req);
    const id = int(p.id, 'id');
    switch (kind(p.kind)) {
      case 'movie':
        return movieDetail(id);
      case 'series':
        return seriesDetail(id);
      case 'artist':
        return artistDetail(id);
      case 'book':
        return bookDetail(id);
      default:
        throw new HttpError('No detail view for this type', 404);
    }
  });

  app.get('/api/options/:service', async (req) => addOptions(arrService(params(req).service)));

  app.post('/api/library/:kind', async (req) => {
    const b = body<AddRequest & Record<string, unknown>>(req);
    return addMedia(kind(params(req).kind), {
      raw: b.raw,
      qualityProfileId: optInt(b.qualityProfileId),
      metadataProfileId: optInt(b.metadataProfileId),
      rootFolderPath: typeof b.rootFolderPath === 'string' ? b.rootFolderPath : undefined,
      monitor: typeof b.monitor === 'string' ? b.monitor : undefined,
      minimumAvailability: typeof b.minimumAvailability === 'string' ? b.minimumAvailability : undefined,
      seriesType: typeof b.seriesType === 'string' ? b.seriesType : undefined,
      search: typeof b.search === 'boolean' ? b.search : undefined,
    });
  });

  app.post('/api/library/:kind/:id/search', async (req) => {
    const p = params(req);
    const b = body(req);
    await searchNow(kind(p.kind), int(p.id, 'id'), {
      seasonNumber: optInt(b.seasonNumber),
      episodeIds: intList(b.episodeIds),
      albumIds: intList(b.albumIds),
    });
    return { ok: true };
  });

  app.post('/api/library/:kind/:id/monitor', async (req) => {
    const p = params(req);
    const b = body(req);
    await setMonitored(kind(p.kind), int(p.id, 'id'), bool(b.monitored), {
      seasonNumber: optInt(b.seasonNumber),
      episodeIds: intList(b.episodeIds),
      albumIds: intList(b.albumIds),
    });
    return { ok: true };
  });

  app.delete('/api/library/:kind/:id', async (req) => {
    requireAdmin(req);
    const p = params(req);
    await deleteMedia(kind(p.kind), int(p.id, 'id'), bool(query(req).deleteFiles));
    return { ok: true };
  });

  app.get('/api/library/:kind/:id/releases', async (req) => {
    const p = params(req);
    const q = query(req);
    return releasesFor(kind(p.kind), int(p.id, 'id'), { seasonNumber: optInt(q.seasonNumber), episodeId: optInt(q.episodeId) });
  });

  app.post('/api/releases/grab', async (req) => {
    const b = body(req);
    await grabArrRelease(arrService(str(b.service, 'service')), str(b.guid, 'guid'), int(b.indexerId, 'indexerId'));
    return { ok: true };
  });

  app.get('/api/discover', async (req) => {
    if (!services().radarr) return [];
    try {
      return await discover();
    } catch (err) {
      req.log.debug(`discover unavailable: ${(err as Error).message}`);
      return [];
    }
  });

  // Posters & fanart cached by the *arr apps (needs their API key, so we proxy them)
  app.get('/api/artwork/:service/*', async (req, reply) => {
    const p = params(req);
    const service = arrService(p.service);
    const rest = p['*'] || '';
    if (!ARTWORK_PATH.test(rest)) throw new HttpError('Invalid artwork path', 400);
    const svc = services()[service];
    if (!svc) throw new HttpError('Service not configured', 404);
    const res = await svc.mediaCover(rest);
    if (!res.ok) {
      // resized variants are created lazily by the *arr apps - fall back to the original
      const original = rest.replace(/-\d+(\.\w+)$/, '$1');
      const res2 = original !== rest ? await svc.mediaCover(original) : res;
      if (!res2.ok) return reply.code(404).send();
      return sendImage(reply, res2);
    }
    return sendImage(reply, res);
  });
}

async function sendImage(reply: import('fastify').FastifyReply, res: Response) {
  const type = res.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) return reply.code(404).send();
  reply.header('Content-Type', type);
  reply.header('Cache-Control', 'private, max-age=86400');
  return reply.send(Buffer.from(await res.arrayBuffer()));
}
