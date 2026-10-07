/* One downloads list: every download client, annotated with what Radarr/Sonarr/Lidarr/Readarr know about it. */
import { ARR_IDS, SERVICE_NAMES } from '../config.js';
import { cached } from '../util/cache.js';
import { services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { DownloadItem } from '../services/clients/types.js';
import type { ArrService, ClientSummary, DownloadStateView, DownloadView, DownloadsResponse, MediaKind } from '../types.js';
import { libraryArtwork } from './media.js';
import { JellyfinService } from '../services/jellyfin.js';
import { grabViews } from './grabs.js';
import { parseHms } from '../services/clients/types.js';

interface ArrQueueGroup {
  service: ArrService;
  records: Raw[];
}


function describe(group: ArrQueueGroup): DownloadView['media'] {
  const r = group.records[0];
  switch (group.service) {
    case 'radarr':
      return r.movie
        ? { service: 'radarr', kind: 'movie', id: r.movieId, title: r.movie.title, subtitle: r.movie.year ? String(r.movie.year) : undefined, ...libraryArtwork('radarr', r.movie, r.movieId) }
        : undefined;
    case 'sonarr': {
      if (!r.series) return undefined;
      const seen = new Set<number>();
      const eps = group.records
        .filter((x) => x.episode && !seen.has(x.episode.id) && seen.add(x.episode.id))
        .map((x) => x.episode as Raw);
      let subtitle: string | undefined;
      if (eps.length === 1) {
        const e = eps[0];
        subtitle = `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} · ${e.title}`;
      } else if (eps.length > 1) {
        const seasons = [...new Set(eps.map((e) => e.seasonNumber))];
        subtitle = seasons.length === 1 ? `Season ${seasons[0]} · ${eps.length} episodes` : `${eps.length} episodes`;
      }
      return { service: 'sonarr', kind: 'series', id: r.seriesId, title: r.series.title, subtitle, ...libraryArtwork('sonarr', r.series, r.seriesId) };
    }
    case 'lidarr':
      return r.artist || r.album
        ? {
            service: 'lidarr',
            kind: (r.album ? 'album' : 'artist') as MediaKind,
            id: r.artistId,
            title: r.album?.title || r.artist?.artistName,
            subtitle: r.album ? r.artist?.artistName : undefined,
            ...(r.album ? libraryArtwork('lidarr', r.album, r.albumId, 'album') : libraryArtwork('lidarr', r.artist, r.artistId, 'artist')),
          }
        : undefined;
    case 'readarr':
      return r.book
        ? { service: 'readarr', kind: 'book', id: r.bookId, title: r.book.title, subtitle: r.author?.authorName, ...libraryArtwork('readarr', r.book, r.bookId) }
        : undefined;
  }
}

function arrInfo(group: ArrQueueGroup): DownloadView['arr'] {
  const r = group.records[0];
  const messages = new Set<string>();
  for (const rec of group.records) {
    if (rec.errorMessage) messages.add(rec.errorMessage);
    for (const sm of (rec.statusMessages || []) as Raw[]) {
      for (const m of (sm.messages || []) as string[]) messages.add(m);
    }
  }
  return {
    service: group.service,
    queueIds: group.records.map((x) => x.id as number),
    status: r.status,
    trackedState: r.trackedDownloadState,
    trackedStatus: r.trackedDownloadStatus,
    messages: [...messages].slice(0, 5),
  };
}

function arrState(r: Raw): DownloadStateView {
  const status = String(r.status || '').toLowerCase();
  const tracked = String(r.trackedDownloadState || '').toLowerCase();
  if (tracked === 'importpending' || tracked === 'importing') return 'importing';
  if (tracked === 'importblocked' || r.trackedDownloadStatus === 'warning') return 'warning';
  if (tracked === 'failedpending' || status === 'failed') return 'failed';
  if (status === 'paused') return 'paused';
  if (status === 'queued' || status === 'delay' || status === 'downloadclientunavailable') return 'queued';
  if (status === 'completed') return 'completed';
  return 'downloading';
}

async function arrQueues(errors: string[]): Promise<Map<string, ArrQueueGroup>> {
  const s = services();
  const groups = new Map<string, ArrQueueGroup>();
  await Promise.all(
    ARR_IDS.map(async (id) => {
      const svc = s[id];
      if (!svc) return;
      const include: Record<string, boolean> =
        id === 'radarr'
          ? { includeMovie: true }
          : id === 'sonarr'
            ? { includeSeries: true, includeEpisode: true }
            : id === 'lidarr'
              ? { includeArtist: true, includeAlbum: true }
              : { includeAuthor: true, includeBook: true };
      try {
        const page = await svc.queue(include);
        for (const rec of page.records || []) {
          const key = rec.downloadId ? `${String(rec.downloadId).toLowerCase()}` : `${id}:${rec.id}`;
          const g = groups.get(key);
          if (g && g.service === id) g.records.push(rec);
          else if (!g) groups.set(key, { service: id, records: [rec] });
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return groups;
}

/** downloadId -> what the *arr apps grabbed/imported it as (finished downloads leave the queue). */
function arrHistoryIndex(): Promise<Map<string, ArrQueueGroup & { imported: boolean }>> {
  return cached('downloads:history', 60_000, async () => {
    const s = services();
    const map = new Map<string, ArrQueueGroup & { imported: boolean }>();
    await Promise.all(
      ARR_IDS.map(async (id) => {
        const svc = s[id];
        if (!svc) return;
        const include: Record<string, boolean> =
          id === 'radarr'
            ? { includeMovie: true }
            : id === 'sonarr'
              ? { includeSeries: true, includeEpisode: true }
              : id === 'lidarr'
                ? { includeArtist: true, includeAlbum: true }
                : { includeAuthor: true, includeBook: true };
        try {
          const page = await svc.history({ pageSize: 250, ...include });
          for (const r of page.records || []) {
            if (!r.downloadId) continue;
            const key = String(r.downloadId).toLowerCase();
            let g = map.get(key);
            if (!g) map.set(key, (g = { service: id, records: [], imported: false }));
            if (g.service !== id) continue;
            if (/imported/i.test(String(r.eventType))) g.imported = true;
            g.records.push(r);
          }
        } catch {
          /* service offline */
        }
      }),
    );
    return map;
  });
}

async function linkJellyfin(pairs: [DownloadView, ArrQueueGroup][]): Promise<void> {
  const jf = services().jellyfin;
  if (!jf || !pairs.length) return;
  try {
    const [index, serverId] = await Promise.all([jf.getIndex(), jf.getServerId().catch(() => undefined)]);
    for (const [it, g] of pairs) {
      const r = g.records[0];
      if (!it.media || !it.imported || !r) continue;
      const ref =
        it.media.service === 'radarr'
          ? JellyfinService.lookup(index, { type: 'Movie', tmdb: r.movie?.tmdbId, imdb: r.movie?.imdbId })
          : it.media.service === 'sonarr'
            ? JellyfinService.lookup(index, { type: 'Series', tvdb: r.series?.tvdbId, tmdb: r.series?.tmdbId })
            : it.media.service === 'lidarr'
              ? JellyfinService.lookup(index, { type: 'MusicAlbum', mbReleaseGroup: r.album?.foreignAlbumId, name: r.album?.title })
              : undefined;
      if (ref) it.media.jellyfinUrl = jf.itemUrl(ref.id, serverId);
    }
  } catch {
    /* Jellyfin offline */
  }
}

function fromClient(item: DownloadItem): DownloadView {
  return {
    ...item,
    key: `${item.client}:${item.id}`,
    controllable: true,
    state: item.state,
  };
}

function fromArrOnly(group: ArrQueueGroup): DownloadView {
  const r = group.records[0];
  const size = r.size || 0;
  const left = r.sizeleft ?? 0;
  return {
    key: `arr:${group.service}:${r.downloadId || r.id}`,
    client: 'arr',
    clientName: r.downloadClient || SERVICE_NAMES[group.service],
    controllable: false,
    protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
    id: String(r.downloadId || r.id),
    name: r.title,
    category: '',
    state: arrState(r),
    rawState: r.status,
    progress: size > 0 ? Math.max(0, Math.min(1, 1 - left / size)) : 0,
    size,
    downloaded: Math.max(0, size - left),
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: parseHms(r.timeleft),
    addedAt: r.added,
    done: String(r.status).toLowerCase() === 'completed',
    paused: String(r.status).toLowerCase() === 'paused',
  };
}

export function getDownloads(): Promise<DownloadsResponse> {
  return cached('downloads', 1500, buildDownloads);
}

async function buildDownloads(): Promise<DownloadsResponse> {
  const s = services();
  const errors: string[] = [];
  const clientSummaries: ClientSummary[] = [];
  const items: DownloadView[] = [];

  const [groups] = await Promise.all([
    arrQueues(errors),
    Promise.all(
      s.clients.map(async (c) => {
        const summary: ClientSummary = {
          id: c.id,
          name: c.name,
          protocol: c.protocol,
          online: false,
          downloadSpeed: 0,
          uploadSpeed: 0,
          supportsAltSpeed: c.supportsAltSpeed,
          publicUrl: c.publicUrl,
        };
        clientSummaries.push(summary);
        try {
          const [list, stats] = await Promise.all([c.list(), c.stats()]);
          summary.online = true;
          Object.assign(summary, {
            downloadSpeed: stats.downloadSpeed,
            uploadSpeed: stats.uploadSpeed,
            altSpeed: stats.altSpeed,
            paused: stats.paused,
          });
          items.push(...list.map(fromClient));
        } catch (err) {
          summary.error = err instanceof Error ? err.message : String(err);
          errors.push(summary.error);
        }
      }),
    ),
  ]);

  // Attach *arr info to client items
  const used = new Set<string>();
  for (const it of items) {
    const key = [it.id, ...(it.altIds || [])].map((x) => x.toLowerCase()).find((k) => groups.has(k));
    if (!key) continue;
    const g = groups.get(key)!;
    used.add(key);
    it.media = describe(g);
    it.arr = arrInfo(g);
    const st = arrState(g.records[0]);
    if (it.done && (st === 'importing' || st === 'warning')) it.state = st;
  }
  // Finished downloads have left the *arr queues - recognise them from the history
  const history = await arrHistoryIndex().catch(() => new Map<string, ArrQueueGroup & { imported: boolean }>());
  const finished: [DownloadView, ArrQueueGroup][] = [];
  for (const it of items) {
    if (it.media) continue;
    const key = [it.id, ...(it.altIds || [])].map((x) => x.toLowerCase()).find((k) => history.has(k));
    if (!key) continue;
    const g = history.get(key)!;
    it.media = describe(g);
    it.imported = g.imported;
    finished.push([it, g]);
  }
  await linkJellyfin(finished);

  // Items that only the *arr apps know about (client not configured in AIO Arr)
  for (const [key, g] of groups) {
    if (used.has(key)) continue;
    const view = fromArrOnly(g);
    view.media = describe(g);
    view.arr = arrInfo(g);
    items.push(view);
  }

  // Direct grabs made from AIO Arr (music, audiobooks, files)
  const grabs = grabViews();
  for (const it of items) {
    const grab = grabs.find((g) => g.downloadId && g.downloadId.toLowerCase() === it.id.toLowerCase() && g.client === it.client);
    if (grab) {
      it.grab = grab;
      if (grab.status === 'importing') it.state = 'importing';
    }
  }

  const rank = (v: DownloadView) => {
    if (['downloading', 'metadata', 'stalled', 'checking'].includes(v.state)) return 0;
    if (['importing', 'processing', 'warning', 'failed', 'error'].includes(v.state)) return 1;
    if (['queued', 'paused'].includes(v.state)) return 2;
    return 3;
  };
  items.sort((a, b) => rank(a) - rank(b) || String(b.addedAt || b.completedAt || '').localeCompare(String(a.addedAt || a.completedAt || '')));

  clientSummaries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    items,
    clients: clientSummaries,
    totals: {
      downloadSpeed: clientSummaries.reduce((n, c) => n + (c.downloadSpeed || 0), 0),
      uploadSpeed: clientSummaries.reduce((n, c) => n + (c.uploadSpeed || 0), 0),
      active: items.filter((i) => rank(i) === 0).length,
    },
    errors,
  };
}
