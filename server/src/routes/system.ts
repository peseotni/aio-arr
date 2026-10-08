import type { FastifyInstance } from 'fastify';
import { ARR_IDS, CONTENT_TYPES, SERVICE_IDS, SERVICE_NAMES, getSettings } from '../config.js';
import { authConfig } from '../auth.js';
import { HttpError } from '../util/http.js';
import { invalidate } from '../util/cache.js';
import { need, services } from '../services/registry.js';
import { activity, calendar, jellyfinHome, jellyfinSessions, searchMissing, serviceStatus, wanted } from '../domain/overview.js';
import type { AppInfo, ArrService } from '../types.js';
import { docker } from '../services/docker.js';
import { categoryInfo } from '../domain/categories.js';
import { homeLink, keepAsDownload } from '../domain/players.js';
import { libraryRoot } from '../domain/grabs.js';
import { VERSION } from '../version.js';
import { body, intList, optInt, params, query, requireAdmin, str } from './util.js';

const COMMANDS: Record<string, string[]> = {
  radarr: ['RssSync', 'RefreshMonitoredDownloads', 'MissingMoviesSearch', 'RefreshMovie', 'Backup'],
  sonarr: ['RssSync', 'RefreshMonitoredDownloads', 'MissingEpisodeSearch', 'RefreshSeries', 'Backup'],
  lidarr: ['RssSync', 'RefreshMonitoredDownloads', 'MissingAlbumSearch', 'RefreshArtist', 'Backup'],
  readarr: ['RssSync', 'RefreshMonitoredDownloads', 'MissingBookSearch', 'RefreshAuthor', 'Backup'],
  prowlarr: ['ApplicationIndexerSync', 'Backup'],
};

function arr(v: string): ArrService {
  if (!(ARR_IDS as readonly string[]).includes(v)) throw new HttpError(`Unknown service "${v}"`, 404);
  return v as ArrService;
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/app', async (req): Promise<AppInfo> => {
    const s = getSettings();
    const reg = services();
    const svcInfo: AppInfo['services'] = {};
    for (const id of SERVICE_IDS) {
      const cfg = s.services[id];
      svcInfo[id] = { enabled: !!reg[id], name: SERVICE_NAMES[id], publicUrl: reg[id]?.publicUrl || cfg.publicUrl || cfg.url };
    }
    let jellyfin: AppInfo['jellyfin'];
    if (reg.jellyfin) jellyfin = { publicUrl: reg.jellyfin.publicUrl, serverId: await reg.jellyfin.getServerId().catch(() => undefined) };
    const players: AppInfo['players'] = {};
    for (const t of CONTENT_TYPES) {
      const l = homeLink(t, reg);
      if (l) players[t] = { app: l.app, name: l.name, url: l.url };
    }
    const user = req.user!;
    return {
      title: s.general.title,
      version: VERSION,
      user: { username: user.username, role: user.role, source: user.source },
      authMode: authConfig.mode,
      services: svcInfo,
      clients: reg.clients.map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, publicUrl: c.publicUrl })),
      jellyfin,
      players,
      watchApp: players.movies || players.tv,
      categories: categoryInfo(reg),
      features: {
        music: !!reg.lidarr || !!s.paths.music,
        books: !!reg.readarr,
        indexerSearch: !!reg.prowlarr,
        files: true,
        subtitles: !!reg.bazarr,
        recommendations: !!(reg.radarr || reg.sonarr),
        updates: !!docker(),
      },
      libraries: (['music', 'audiobook', 'ebook', 'comic'] as const).filter((k) => !!libraryRoot(k)),
      keepAsFiles: CONTENT_TYPES.filter((t) => keepAsDownload(t)),
    };
  });

  app.get('/api/status', async (req) => {
    if (query(req).refresh) invalidate('status');
    return serviceStatus();
  });

  app.get('/api/calendar', async (req) => {
    const q = query(req);
    const start = q.start && !Number.isNaN(Date.parse(q.start)) ? new Date(q.start) : new Date(Date.now() - 86400000);
    const end = q.end && !Number.isNaN(Date.parse(q.end)) ? new Date(q.end) : new Date(start.getTime() + 14 * 86400000);
    if (end.getTime() - start.getTime() > 120 * 86400000) throw new HttpError('Range too large', 400);
    return calendar(start.toISOString(), end.toISOString());
  });

  app.get('/api/wanted/:service', async (req) => wanted(arr(params(req).service), optInt(query(req).page) || 1));

  app.post('/api/wanted/:service/search', async (req) => {
    const service = arr(params(req).service);
    await searchMissing(service, intList(body(req).ids));
    return { ok: true };
  });

  app.get('/api/activity', async (req) => activity(Math.min(optInt(query(req).limit) || 30, 100)));

  app.post('/api/command', async (req) => {
    requireAdmin(req);
    const b = body(req);
    const service = str(b.service, 'service');
    const name = str(b.name, 'name');
    if (!COMMANDS[service]?.includes(name)) throw new HttpError('Command not allowed', 400);
    const svc = services()[service as ArrService | 'prowlarr'];
    if (!svc) throw new HttpError(`${service} is not configured`, 409);
    await (svc as unknown as { command(n: string): Promise<unknown> }).command(name);
    invalidate('downloads', 'status');
    return { ok: true };
  });

  /* ---------------- Jellyfin ---------------- */

  app.get('/api/jellyfin/home', async (req) => {
    if (!services().jellyfin) return { resume: [], nextUp: [], latest: [] };
    return jellyfinHome(req.user?.jellyfinUserId);
  });

  app.get('/api/jellyfin/sessions', async () => {
    if (!services().jellyfin) return [];
    return jellyfinSessions();
  });

  app.post('/api/jellyfin/scan', async (req) => {
    requireAdmin(req);
    await need(services().jellyfin, 'Jellyfin').refreshLibrary();
    return { ok: true };
  });

  app.get('/api/jellyfin/image/:id/:type', async (req, reply) => {
    const p = params(req);
    if (!/^[a-f0-9-]{32,36}$/i.test(p.id) || !/^(Primary|Backdrop|Thumb|Logo|Banner)$/.test(p.type)) throw new HttpError('Invalid image', 400);
    const w = Math.min(Math.max(optInt(query(req).w) || 400, 50), 1920);
    const res = await need(services().jellyfin, 'Jellyfin').image(p.id, p.type, { maxWidth: w, quality: 90 });
    if (!res.ok) return reply.code(404).send();
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return reply.code(404).send();
    reply.header('Content-Type', type);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });

  app.get('/api/jellyfin/find', async (req) => {
    const jf = need(services().jellyfin, 'Jellyfin');
    const q = query(req);
    const type = q.type === 'series' ? 'Series' : q.type === 'album' ? 'MusicAlbum' : q.type === 'artist' ? 'MusicArtist' : 'Movie';
    const ref = await jf.find({ type, tmdb: q.tmdb, tvdb: q.tvdb, imdb: q.imdb, mbReleaseGroup: q.mb, mbArtist: q.mb, name: q.name });
    if (!ref) throw new HttpError('Not found in Jellyfin yet', 404);
    return { id: ref.id, url: jf.itemUrl(ref.id, await jf.getServerId().catch(() => undefined)) };
  });

  /* ---------------- Subtitles ---------------- */

  app.get('/api/subtitles/badges', async () => {
    const bazarr = services().bazarr;
    if (!bazarr) return {};
    return bazarr.badges();
  });

  app.post('/api/subtitles/search', async (req) => {
    const bazarr = need(services().bazarr, 'Bazarr');
    const b = body(req);
    const id = optInt(b.id);
    if (!id) throw new HttpError('id is required', 400);
    if (b.kind === 'movie') await bazarr.searchMovie(id);
    else if (b.kind === 'series') await bazarr.searchSeries(id);
    else throw new HttpError('kind must be movie or series', 400);
    return { ok: true };
  });
}
