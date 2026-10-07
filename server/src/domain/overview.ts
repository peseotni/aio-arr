/* Dashboard data: service health, disk space, calendar, wanted lists, activity, discover, Jellyfin rows. */
import { ARR_IDS, CLIENT_IDS, SERVICE_IDS, SERVICE_NAMES, getSettings } from '../config.js';
import { cached } from '../util/cache.js';
import { need, services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { JRaw } from '../services/jellyfin.js';
import type { ActivityItem, ArrService, CalendarEvent, DiskView, HealthIssue, MediaItem, ServiceStatusView, WantedItem } from '../types.js';
import { attachJellyfin, libraryArtwork, movieItem } from './media.js';
import { rawMovies } from './library.js';

const GROUP: Record<string, ServiceStatusView['group']> = {
  radarr: 'media',
  sonarr: 'media',
  lidarr: 'media',
  readarr: 'media',
  prowlarr: 'indexer',
  bazarr: 'subtitles',
  jellyfin: 'player',
  navidrome: 'player',
  audiobookshelf: 'player',
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------ status ------------------------------ */

export function serviceStatus(): Promise<{ services: ServiceStatusView[]; disks: DiskView[] }> {
  return cached('status', 20_000, async () => {
    const s = services();
    const settings = getSettings();
    const disks = new Map<string, DiskView>();
    const views: ServiceStatusView[] = [];

    const tasks = SERVICE_IDS.map(async (id) => {
      const cfg = settings.services[id];
      const svc = s[id];
      const view: ServiceStatusView = {
        id,
        name: SERVICE_NAMES[id],
        group: GROUP[id],
        enabled: !!svc,
        online: false,
        publicUrl: cfg.publicUrl || cfg.url,
        health: [],
      };
      views.push(view);
      if (!svc) return;
      try {
        const t = await svc.test();
        view.online = true;
        view.version = t.version;
        if ((ARR_IDS as readonly string[]).includes(id) || id === 'prowlarr') {
          const arr = svc as unknown as { health(): Promise<HealthIssue[]>; diskspace(): Promise<Raw[]> };
          const [health, space] = await Promise.all([arr.health().catch(() => []), id === 'prowlarr' ? [] : arr.diskspace().catch(() => [])]);
          view.health = health.map((h) => ({ type: h.type, message: h.message, wikiUrl: h.wikiUrl, source: h.source }));
          for (const d of space as Raw[]) {
            if (!d.totalSpace || d.path === '/config' || /^\/(config|app|etc|proc|sys|dev|run)/.test(d.path)) continue;
            // the same disk is usually reported by several apps under different mount points
            const key = `${d.totalSpace}:${Math.round(d.freeSpace / 1e8)}`;
            const existing = disks.get(key);
            if (existing) {
              if (!existing.services.includes(view.name)) existing.services.push(view.name);
              if (d.path.length < existing.path.length) existing.path = d.path;
            } else disks.set(key, { path: d.path, label: d.label || undefined, free: d.freeSpace, total: d.totalSpace, services: [view.name] });
          }
        } else if (id === 'bazarr') {
          const health = await s.bazarr!.health().catch(() => []);
          view.health = health.map((h) => ({ type: 'warning' as const, message: `${h.object}: ${h.issue}` }));
        }
      } catch (err) {
        view.error = errMsg(err);
      }
    });

    const clientTasks = CLIENT_IDS.map(async (id) => {
      const cfg = settings.clients[id];
      const c = s.clients.find((x) => x.id === id);
      const view: ServiceStatusView = {
        id,
        name: SERVICE_NAMES[id],
        group: 'download',
        enabled: !!c,
        online: false,
        publicUrl: cfg.publicUrl || cfg.url,
        health: [],
      };
      views.push(view);
      if (!c) return;
      try {
        const t = await c.test();
        view.online = true;
        view.version = t.version;
      } catch (err) {
        view.error = errMsg(err);
      }
    });

    await Promise.all([...tasks, ...clientTasks]);
    const order = [...SERVICE_IDS, ...CLIENT_IDS] as string[];
    views.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { services: views, disks: [...disks.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  });
}

/* ------------------------------ calendar ------------------------------ */

const art = libraryArtwork;

export function calendar(start: string, end: string): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  return cached(`calendar:${start}:${end}`, 60_000, async () => {
    const s = services();
    const events: CalendarEvent[] = [];
    const errors: string[] = [];
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    const inRange = (d?: string) => !!d && Date.parse(d) >= startMs && Date.parse(d) <= endMs;
    await Promise.all([
      s.sonarr &&
        s.sonarr
          .calendar(start, end, { includeSeries: true })
          .then((eps) => {
            for (const e of eps) {
              events.push({
                key: `ep:${e.id}`,
                type: 'episode',
                service: 'sonarr',
                date: e.airDateUtc || e.airDate,
                title: e.series?.title || 'Episode',
                subtitle: `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}`,
                hasFile: !!e.hasFile,
                monitored: !!e.monitored,
                ...art('sonarr', e.series, e.seriesId),
                mediaId: e.seriesId,
              });
            }
          })
          .catch((err) => errors.push(errMsg(err))),
      s.radarr &&
        s.radarr
          .calendar(start, end)
          .then((movies) => {
            for (const m of movies) {
              const dates: [string, string | undefined][] = [
                ['In cinemas', m.inCinemas],
                ['Digital release', m.digitalRelease],
                ['Physical release', m.physicalRelease],
              ];
              for (const [label, d] of dates) {
                if (!inRange(d)) continue;
                events.push({
                  key: `movie:${m.id}:${label}`,
                  type: 'movie',
                  service: 'radarr',
                  date: d!,
                  dateType: label,
                  title: m.title,
                  subtitle: label,
                  hasFile: !!m.hasFile,
                  monitored: !!m.monitored,
                  ...art('radarr', m, m.id),
                  mediaId: m.id,
                  allDay: true,
                });
              }
            }
          })
          .catch((err) => errors.push(errMsg(err))),
      s.lidarr &&
        s.lidarr
          .calendar(start, end, { includeArtist: true })
          .then((albums) => {
            for (const a of albums) {
              events.push({
                key: `album:${a.id}`,
                type: 'album',
                service: 'lidarr',
                date: a.releaseDate,
                title: a.title,
                subtitle: a.artist?.artistName,
                hasFile: (a.statistics?.trackFileCount ?? 0) > 0,
                monitored: !!a.monitored,
                ...art('lidarr', a, a.id, 'album'),
                mediaId: a.artistId,
                allDay: true,
              });
            }
          })
          .catch((err) => errors.push(errMsg(err))),
      s.readarr &&
        s.readarr
          .calendar(start, end, { includeAuthor: true })
          .then((books) => {
            for (const b of books) {
              events.push({
                key: `book:${b.id}`,
                type: 'book',
                service: 'readarr',
                date: b.releaseDate,
                title: b.title,
                subtitle: b.author?.authorName,
                hasFile: (b.statistics?.bookFileCount ?? 0) > 0,
                monitored: !!b.monitored,
                ...art('readarr', b, b.id),
                mediaId: b.id,
                allDay: true,
              });
            }
          })
          .catch((err) => errors.push(errMsg(err))),
    ]);
    events.sort((a, b) => a.date.localeCompare(b.date));
    return { events, errors };
  });
}

/* ------------------------------ wanted ------------------------------ */

export function wanted(service: ArrService, page = 1): Promise<{ items: WantedItem[]; total: number }> {
  return cached(`wanted:${service}:${page}`, 30_000, async () => {
    const s = services();
    switch (service) {
      case 'sonarr': {
        const r = await need(s.sonarr, 'Sonarr').wantedMissing({ page, pageSize: 50, includeSeries: true, sortKey: 'episodes.airDateUtc', sortDirection: 'descending' });
        return {
          total: r.totalRecords,
          items: r.records.map((e) => ({
            key: `ep:${e.id}`,
            service: 'sonarr' as const,
            kind: 'episode' as const,
            id: e.id,
            mediaId: e.seriesId,
            title: e.series?.title || 'Episode',
            subtitle: `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}`,
            date: e.airDateUtc,
            ...art('sonarr', e.series, e.seriesId),
          })),
        };
      }
      case 'radarr': {
        const r = await need(s.radarr, 'Radarr').wantedMissing({ page, pageSize: 50, sortKey: 'movies.sortTitle', sortDirection: 'ascending' });
        return {
          total: r.totalRecords,
          items: r.records.map((m) => ({
            key: `movie:${m.id}`,
            service: 'radarr' as const,
            kind: 'movie' as const,
            id: m.id,
            mediaId: m.id,
            title: m.title,
            subtitle: m.year ? String(m.year) : undefined,
            date: m.digitalRelease || m.physicalRelease || m.inCinemas,
            ...art('radarr', m, m.id),
          })),
        };
      }
      case 'lidarr': {
        const r = await need(s.lidarr, 'Lidarr').wantedMissing({ page, pageSize: 50, includeArtist: true, sortKey: 'releaseDate', sortDirection: 'descending' });
        return {
          total: r.totalRecords,
          items: r.records.map((a) => ({
            key: `album:${a.id}`,
            service: 'lidarr' as const,
            kind: 'album' as const,
            id: a.id,
            mediaId: a.artistId,
            title: a.title,
            subtitle: a.artist?.artistName,
            date: a.releaseDate,
            ...art('lidarr', a, a.id, 'album'),
          })),
        };
      }
      case 'readarr': {
        const r = await need(s.readarr, 'Readarr').wantedMissing({ page, pageSize: 50, includeAuthor: true, sortKey: 'releaseDate', sortDirection: 'descending' });
        return {
          total: r.totalRecords,
          items: r.records.map((b) => ({
            key: `book:${b.id}`,
            service: 'readarr' as const,
            kind: 'book' as const,
            id: b.id,
            mediaId: b.id,
            title: b.title,
            subtitle: b.author?.authorName,
            date: b.releaseDate,
            ...art('readarr', b, b.id),
          })),
        };
      }
    }
  });
}

export async function searchMissing(service: ArrService, ids?: number[]): Promise<void> {
  const s = services();
  switch (service) {
    case 'sonarr':
      await need(s.sonarr, 'Sonarr').command(ids?.length ? 'EpisodeSearch' : 'MissingEpisodeSearch', ids?.length ? { episodeIds: ids } : {});
      return;
    case 'radarr':
      await need(s.radarr, 'Radarr').command(ids?.length ? 'MoviesSearch' : 'MissingMoviesSearch', ids?.length ? { movieIds: ids } : {});
      return;
    case 'lidarr':
      await need(s.lidarr, 'Lidarr').command(ids?.length ? 'AlbumSearch' : 'MissingAlbumSearch', ids?.length ? { albumIds: ids } : {});
      return;
    case 'readarr':
      await need(s.readarr, 'Readarr').command(ids?.length ? 'BookSearch' : 'MissingBookSearch', ids?.length ? { bookIds: ids } : {});
      return;
  }
}

/* ------------------------------ activity ------------------------------ */

const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadFolderImported: 'Imported',
  downloadImported: 'Imported',
  trackFileImported: 'Imported',
  bookFileImported: 'Imported',
  downloadFailed: 'Download failed',
  importFailed: 'Import failed',
  albumImportIncomplete: 'Import incomplete',
  movieFileDeleted: 'File deleted',
  episodeFileDeleted: 'File deleted',
  trackFileDeleted: 'File deleted',
  movieFileRenamed: 'Renamed',
  episodeFileRenamed: 'Renamed',
  trackFileRenamed: 'Renamed',
  downloadIgnored: 'Ignored',
};

export function activity(limit = 30): Promise<ActivityItem[]> {
  return cached(`activity:${limit}`, 30_000, async () => {
    const s = services();
    const items: ActivityItem[] = [];
    await Promise.all(
      ARR_IDS.map(async (id) => {
        const svc = s[id];
        if (!svc) return;
        const include: Record<string, boolean> =
          id === 'radarr' ? { includeMovie: true } : id === 'sonarr' ? { includeSeries: true, includeEpisode: true } : id === 'lidarr' ? { includeArtist: true, includeAlbum: true } : { includeAuthor: true, includeBook: true };
        try {
          const page = await svc.history({ pageSize: limit, ...include });
          for (const h of page.records) {
            const media = h.movie || h.series || h.album || h.artist || h.book;
            let mediaTitle: string | undefined = h.movie?.title || h.series?.title || h.album?.title || h.artist?.artistName || h.book?.title;
            if (h.episode) mediaTitle = `${mediaTitle} · S${String(h.episode.seasonNumber).padStart(2, '0')}E${String(h.episode.episodeNumber).padStart(2, '0')}`;
            items.push({
              key: `${id}:${h.id}`,
              service: id,
              date: h.date,
              event: EVENT_LABEL[h.eventType] || String(h.eventType),
              title: h.sourceTitle,
              mediaTitle,
              quality: h.quality?.quality?.name,
              ...art(id, media, h.movieId || h.seriesId || h.albumId || h.bookId, h.albumId ? 'album' : undefined),
            });
          }
        } catch {
          /* service offline */
        }
      }),
    );
    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  });
}

/* ------------------------------ discover ------------------------------ */

export function discover(): Promise<MediaItem[]> {
  return cached('discover', 30 * 60_000, async () => {
    const radarr = need(services().radarr, 'Radarr');
    const [list, lib] = await Promise.all([radarr.discover(), rawMovies().catch(() => [] as Raw[])]);
    const inLib = new Set(lib.map((m) => m.tmdbId));
    const seen = new Set<number>();
    const items = list
      .filter((m) => m.tmdbId && !inLib.has(m.tmdbId) && !m.isExcluded && !seen.has(m.tmdbId) && seen.add(m.tmdbId))
      .slice(0, 40)
      .map((m) => movieItem({ ...m, id: 0 }, { withRaw: true }));
    return attachJellyfin(items, services().jellyfin);
  });
}

/* ------------------------------ jellyfin rows ------------------------------ */

export interface JellyfinCard {
  id: string;
  name: string;
  type: string;
  subtitle?: string;
  image?: string;
  backdrop?: string;
  progress?: number;
  url: string;
  year?: number;
  runtime?: number;
}

function card(i: JRaw, url: string): JellyfinCard {
  const isEp = i.Type === 'Episode';
  // Episodes look better with their series poster / thumb
  const imageId = isEp ? i.SeriesId || i.Id : i.Id;
  const hasPrimary = isEp ? !!i.SeriesPrimaryImageTag || !!i.ImageTags?.Primary : !!i.ImageTags?.Primary;
  const backdropId = i.BackdropImageTags?.length ? i.Id : i.ParentBackdropItemId;
  const thumbId = i.ImageTags?.Thumb ? i.Id : i.ParentThumbItemId;
  return {
    id: i.Id,
    name: isEp ? i.SeriesName : i.Name,
    type: i.Type,
    subtitle: isEp
      ? `S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(i.IndexNumber ?? 0).padStart(2, '0')} · ${i.Name}`
      : i.Type === 'MusicAlbum'
        ? i.AlbumArtist
        : i.ProductionYear
          ? String(i.ProductionYear)
          : undefined,
    image: hasPrimary ? `/api/jellyfin/image/${imageId}/Primary?w=400` : undefined,
    backdrop: thumbId ? `/api/jellyfin/image/${thumbId}/Thumb?w=640` : backdropId ? `/api/jellyfin/image/${backdropId}/Backdrop?w=640` : undefined,
    progress: typeof i.UserData?.PlayedPercentage === 'number' ? i.UserData.PlayedPercentage / 100 : undefined,
    url,
    year: i.ProductionYear,
    runtime: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : undefined,
  };
}

export async function jellyfinHome(userId?: string): Promise<{ resume: JellyfinCard[]; nextUp: JellyfinCard[]; latest: JellyfinCard[]; user?: string }> {
  const jf = need(services().jellyfin, 'Jellyfin');
  const uid = await jf.homeUserId(userId);
  if (!uid) return { resume: [], nextUp: [], latest: [] };
  return cached(`jf:home:${uid}`, 20_000, async () => {
    const serverId = await jf.getServerId().catch(() => undefined);
    const [resume, nextUp, latest] = await Promise.all([
      jf.resume(uid, 12).catch(() => ({ Items: [] as JRaw[] })),
      jf.nextUp(uid, 12).catch(() => ({ Items: [] as JRaw[] })),
      jf.latest(uid, 20).catch(() => [] as JRaw[]),
    ]);
    const mk = (i: JRaw) => card(i, jf.itemUrl(i.Id, serverId));
    const resumeIds = new Set((resume.Items || []).map((i) => i.Id));
    return {
      user: uid,
      resume: (resume.Items || []).map(mk),
      nextUp: (nextUp.Items || []).filter((i) => !resumeIds.has(i.Id)).map(mk),
      latest: (latest || []).map(mk),
    };
  });
}

export interface NowPlaying {
  id: string;
  user: string;
  client: string;
  device: string;
  title: string;
  subtitle?: string;
  image?: string;
  progress?: number;
  paused: boolean;
  transcoding: boolean;
}

export function jellyfinSessions(): Promise<NowPlaying[]> {
  return cached('jf:sessions', 10_000, async () => {
    const jf = need(services().jellyfin, 'Jellyfin');
    const sessions = await jf.sessions();
    return sessions
      .filter((x) => x.NowPlayingItem)
      .map((x) => {
        const it = x.NowPlayingItem as JRaw;
        const ticks = it.RunTimeTicks || 0;
        const pos = x.PlayState?.PositionTicks || 0;
        const isEp = it.Type === 'Episode';
        return {
          id: x.Id,
          user: x.UserName,
          client: x.Client,
          device: x.DeviceName,
          title: isEp ? it.SeriesName : it.Name,
          subtitle: isEp ? `S${String(it.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(it.IndexNumber ?? 0).padStart(2, '0')} · ${it.Name}` : it.Album || undefined,
          image: `/api/jellyfin/image/${isEp && it.SeriesId ? it.SeriesId : it.Id}/Primary?w=200`,
          progress: ticks ? pos / ticks : undefined,
          paused: !!x.PlayState?.IsPaused,
          transcoding: x.PlayState?.PlayMethod === 'Transcode',
        };
      });
  });
}
