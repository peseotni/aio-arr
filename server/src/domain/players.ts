/*
 * "Open with": which app opens which kind of content, the one-click links into it
 * ("Watch in Plex", "Listen in Navidrome", "Read in Komga") and library scans after imports.
 */
import { SERVICE_NAMES, getSettings, type ContentType, type PlayerId } from '../config.js';
import { moduleLogger } from '../log.js';
import { services, type Registry } from '../services/registry.js';
import { JellyfinService } from '../services/jellyfin.js';
import { PlexService } from '../services/plex.js';
import { NavidromeService } from '../services/audio.js';
import type { MediaItem, MediaKind, PlayLink } from '../types.js';

const log = moduleLogger('players');

/** Which apps can open which content. */
export const PLAYER_SUPPORT: Record<PlayerId, ContentType[]> = {
  jellyfin: ['movies', 'tv', 'music', 'audiobooks'],
  plex: ['movies', 'tv', 'music', 'audiobooks'],
  emby: ['movies', 'tv', 'music', 'audiobooks'],
  navidrome: ['music'],
  audiobookshelf: ['audiobooks', 'ebooks'],
  komga: ['comics', 'ebooks'],
  kavita: ['comics', 'ebooks'],
};

/** "Automatic": the first connected app in this order. */
export const AUTO_ORDER: Record<ContentType, PlayerId[]> = {
  movies: ['jellyfin', 'plex', 'emby'],
  tv: ['jellyfin', 'plex', 'emby'],
  music: ['navidrome', 'jellyfin', 'plex', 'emby'],
  audiobooks: ['audiobookshelf', 'jellyfin', 'plex', 'emby'],
  ebooks: ['kavita', 'komga', 'audiobookshelf'],
  comics: ['komga', 'kavita'],
  games: [],
  software: [],
  other: [],
};

export const VERB: Record<ContentType, PlayLink['verb']> = {
  movies: 'Watch',
  tv: 'Watch',
  music: 'Listen',
  audiobooks: 'Listen',
  ebooks: 'Read',
  comics: 'Read',
  games: 'Watch',
  software: 'Watch',
  other: 'Watch',
};

export function contentOf(kind: MediaKind): ContentType {
  return kind === 'movie' ? 'movies' : kind === 'series' ? 'tv' : kind === 'book' ? 'ebooks' : 'music';
}

/** The app that opens a content type: your choice under Settings > Open with, else the first connected one. */
export function playerFor(type: ContentType, reg: Registry = services()): PlayerId | undefined {
  const choice = getSettings().players?.[type] ?? 'auto';
  if (choice === 'download') return undefined;
  if (choice !== 'auto' && reg[choice] && PLAYER_SUPPORT[choice]?.includes(type)) return choice;
  return AUTO_ORDER[type].find((id) => !!reg[id]);
}

/** Downloads of this type stay as files for your browser instead of going into a library. */
export function keepAsDownload(type: ContentType): boolean {
  return getSettings().players?.[type] === 'download';
}

function link(app: PlayerId, type: ContentType, url: string): PlayLink {
  return { app, name: SERVICE_NAMES[app], url, verb: VERB[type] };
}

/** Home page of the app that opens a type (fallback when the item itself can't be found). */
export function homeLink(type: ContentType, reg: Registry = services()): PlayLink | undefined {
  const app = playerFor(type, reg);
  const svc = app ? reg[app] : undefined;
  return app && svc ? link(app, type, svc.publicUrl) : undefined;
}

/* ------------------------------------------------------------------ */
/* Links for library items                                             */
/* ------------------------------------------------------------------ */

export interface ItemQuery {
  kind: MediaKind;
  title: string;
  year?: number;
  artist?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  imdb?: string;
  /** MusicBrainz id (artist, or album release group) */
  mb?: string;
  available?: boolean;
}

const JF_TYPE = { movie: 'Movie', series: 'Series', album: 'MusicAlbum', artist: 'MusicArtist' } as const;
const PLEX_TYPE = { movie: 'movie', series: 'show', album: 'album', artist: 'artist' } as const;

/** Resolve many items against one app (indexes are cached, so this is cheap). */
async function resolveWith(app: PlayerId, type: ContentType, list: ItemQuery[], reg: Registry): Promise<(PlayLink | undefined)[]> {
  const out: (PlayLink | undefined)[] = list.map(() => undefined);
  switch (app) {
    case 'jellyfin':
    case 'emby': {
      const svc = reg[app] as JellyfinService;
      const [index, serverId] = await Promise.all([svc.getIndex(), svc.getServerId().catch(() => undefined)]);
      list.forEach((q, i) => {
        if (q.kind === 'book') return;
        const ref = JellyfinService.lookup(index, {
          type: JF_TYPE[q.kind],
          tmdb: q.tmdb,
          tvdb: q.tvdb,
          imdb: q.imdb,
          mbReleaseGroup: q.kind === 'album' ? q.mb : undefined,
          mbArtist: q.kind === 'artist' ? q.mb : undefined,
          name: q.title,
          year: q.year,
        });
        if (ref) out[i] = link(app, type, svc.itemUrl(ref.id, serverId));
      });
      // Downloaded but not found: the app probably scanned it after our index was built
      if (Date.now() - index.builtAt > 60_000 && list.some((q, i) => q.available && !out[i])) void svc.getIndex(true).catch(() => undefined);
      return out;
    }
    case 'plex': {
      const svc = reg.plex!;
      const [index, machineId] = await Promise.all([svc.getIndex(), svc.getMachineId()]);
      list.forEach((q, i) => {
        if (q.kind === 'book') return;
        const ref = PlexService.lookup(index, { type: PLEX_TYPE[q.kind], tmdb: q.tmdb, tvdb: q.tvdb, imdb: q.imdb, mb: q.mb, name: q.title, year: q.year, artist: q.artist });
        if (ref) out[i] = link(app, type, svc.itemUrl(ref.ratingKey, machineId));
      });
      if (Date.now() - index.builtAt > 60_000 && list.some((q, i) => q.available && !out[i])) void svc.getIndex(true).catch(() => undefined);
      return out;
    }
    case 'navidrome': {
      const svc = reg.navidrome!;
      const index = await svc.getIndex();
      list.forEach((q, i) => {
        if (q.kind !== 'album' && q.kind !== 'artist') return;
        const id = NavidromeService.lookup(index, { type: q.kind, mb: q.kind === 'artist' ? q.mb : undefined, name: q.title, artist: q.artist });
        if (id) out[i] = link(app, type, q.kind === 'album' ? svc.albumUrl(id) : svc.artistUrl(id));
      });
      if (Date.now() - index.builtAt > 60_000 && list.some((q, i) => q.available && !out[i])) void svc.getIndex(true).catch(() => undefined);
      return out;
    }
    default: {
      // reading / audiobook apps have no id index: search by title, only for a handful of items
      if (list.length > 24) return out;
      await Promise.all(
        list.map(async (q, i) => {
          out[i] = await findByTitle(type, q.title, q.artist, reg, app).catch(() => undefined);
        }),
      );
      return out;
    }
  }
}

/** Fill in `play` on library items ("Watch in Jellyfin" ...). Never throws - links are optional. */
export async function attachPlayLinks(items: MediaItem[]): Promise<MediaItem[]> {
  const reg = services();
  const groups = new Map<string, { app: PlayerId; type: ContentType; items: MediaItem[] }>();
  for (const it of items) {
    const type = contentOf(it.kind);
    const app = playerFor(type, reg);
    if (!app) continue;
    const key = `${app}:${type}`;
    if (!groups.has(key)) groups.set(key, { app, type, items: [] });
    groups.get(key)!.items.push(it);
  }
  await Promise.all(
    [...groups.values()].map(async (g) => {
      try {
        const links = await resolveWith(
          g.app,
          g.type,
          g.items.map((it) => ({
            kind: it.kind,
            title: it.title,
            year: it.year,
            artist: it.kind === 'album' ? it.subtitle : undefined,
            tmdb: it.ids.tmdb,
            tvdb: it.ids.tvdb,
            imdb: it.ids.imdb,
            mb: it.ids.mb,
            available: it.availability === 'available' || it.availability === 'partial',
          })),
          reg,
        );
        g.items.forEach((it, i) => {
          if (links[i]) it.play = links[i];
        });
      } catch (err) {
        log.debug(`${g.app} links unavailable: ${(err as Error).message}`);
      }
    }),
  );
  return items;
}

/** One item (downloads list etc.). */
export async function playLinkFor(q: ItemQuery): Promise<PlayLink | undefined> {
  const reg = services();
  const type = contentOf(q.kind);
  const app = playerFor(type, reg);
  if (!app) return undefined;
  try {
    return (await resolveWith(app, type, [q], reg))[0];
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Grabs: find what was just imported                                  */
/* ------------------------------------------------------------------ */

/** Look an imported download up by its title in the app that opens its type. */
export async function findByTitle(type: ContentType, title: string, artist: string | undefined, reg: Registry = services(), app = playerFor(type, reg)): Promise<PlayLink | undefined> {
  if (!app) return undefined;
  switch (app) {
    case 'navidrome': {
      const id = await reg.navidrome!.findAlbum(title, artist);
      return id ? link(app, type, reg.navidrome!.albumUrl(id)) : undefined;
    }
    case 'audiobookshelf': {
      const id = await reg.audiobookshelf!.findItem(title);
      return id ? link(app, type, reg.audiobookshelf!.itemUrl(id)) : undefined;
    }
    case 'komga': {
      const svc = reg.komga!;
      if (type === 'ebooks') {
        const b = await svc.findBook(title);
        if (b) return link(app, type, svc.bookUrl(b.id));
      }
      const s = await svc.findSeries(title);
      return s ? link(app, type, svc.seriesUrl(s.id)) : undefined;
    }
    case 'kavita': {
      const svc = reg.kavita!;
      const s = await svc.findSeries(title);
      return s ? link(app, type, svc.seriesUrl(s.libraryId, s.seriesId)) : undefined;
    }
    case 'plex': {
      const svc = reg.plex!;
      const machineId = await svc.getMachineId();
      let index = await svc.getIndex();
      let ref = PlexService.lookup(index, { type: 'album', name: title, artist });
      if (!ref && Date.now() - index.builtAt > 60_000) {
        index = await svc.getIndex(true);
        ref = PlexService.lookup(index, { type: 'album', name: title, artist });
      }
      return ref ? link(app, type, svc.itemUrl(ref.ratingKey, machineId)) : undefined;
    }
    case 'jellyfin':
    case 'emby': {
      const svc = reg[app] as JellyfinService;
      const res = await svc.search(title);
      const want = type === 'audiobooks' ? ['AudioBook', 'MusicAlbum', 'Book'] : ['MusicAlbum', 'Audio', 'AudioBook'];
      const hit = res?.Items?.find((i) => want.includes(i.Type));
      return hit ? link(app, type, svc.itemUrl(hit.Id, await svc.getServerId().catch(() => undefined))) : undefined;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Library scans                                                       */
/* ------------------------------------------------------------------ */

/**
 * Files appeared in a folder: tell every connected app that can open this type, so links work
 * right away instead of after the next scheduled scan.
 */
export async function notifyImported(type: ContentType, folders: string[]): Promise<void> {
  if (!folders.length) return;
  const reg = services();
  const tasks: Promise<unknown>[] = [];
  const supports = (id: PlayerId) => PLAYER_SUPPORT[id].includes(type) && !!reg[id];
  for (const id of ['jellyfin', 'emby'] as const) if (supports(id)) tasks.push((reg[id] as JellyfinService).notifyPaths(folders));
  if (supports('plex')) for (const f of folders) tasks.push(reg.plex!.scanPath(f));
  if (supports('navidrome')) tasks.push(reg.navidrome!.startScan());
  if (supports('audiobookshelf')) for (const f of folders) tasks.push(reg.audiobookshelf!.scanForPath(f));
  if (supports('komga')) for (const f of folders) tasks.push(reg.komga!.scanForPath(f));
  if (supports('kavita')) for (const f of folders) tasks.push(reg.kavita!.scanForPath(f));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') log.warn('Library scan request failed:', r.reason?.message || r.reason);
}

/** Forget cached library indexes (after imports, so new items get links). */
export function invalidatePlayerIndexes(reg: Registry = services()): void {
  reg.jellyfin?.invalidateIndex();
  reg.emby?.invalidateIndex();
  reg.plex?.invalidateIndex();
  reg.navidrome?.invalidateIndex();
}
