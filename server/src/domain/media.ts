/* Turn *arr resources into the UI's MediaItem shape. */
import type { Availability, ArrService, EpisodeView, FileView, MediaItem, SeasonView } from '../types.js';
import type { Raw } from '../services/arr.js';

/* ------------------------------ images ------------------------------ */

const MEDIACOVER_TYPE: Record<string, string> = { Artists: 'artist', Albums: 'album', Authors: 'author', Books: 'book' };

/** "/MediaCover/5/poster.jpg?lastWrite=1" -> "/api/artwork/radarr/5/poster-500.jpg?lastWrite=1" */
export function localImage(service: ArrService, url: string | undefined, size?: number): string | undefined {
  if (!url) return undefined;
  const idx = url.indexOf('/MediaCover/');
  if (idx < 0) return undefined;
  const [pathPart, query] = url.slice(idx + '/MediaCover/'.length).split('?');
  const segs = pathPart.split('/');
  let rel: string;
  if (segs.length === 3 && MEDIACOVER_TYPE[segs[0]]) rel = `${MEDIACOVER_TYPE[segs[0]]}/${segs[1]}/${segs[2]}`;
  else if (segs.length === 2) rel = `${segs[0]}/${segs[1]}`;
  else return undefined;
  if (size) rel = rel.replace(/\.(jpg|jpeg|png)$/i, `-${size}.$1`);
  return `/api/artwork/${service}/${rel}${query ? `?${query}` : ''}`;
}

/** TMDB originals are huge; request a sensible size instead. */
export function sizedRemote(url: string | undefined, kind: 'poster' | 'fanart'): string | undefined {
  if (!url) return undefined;
  const u = url.replace(/^http:\/\//, 'https://');
  if (u.includes('image.tmdb.org/t/p/')) return u.replace(/\/t\/p\/[^/]+\//, kind === 'poster' ? '/t/p/w342/' : '/t/p/w1280/');
  return u;
}

/**
 * Poster for an item we know is in the library: the *arr app's local cache first (no internet
 * needed in the browser), the remote URL as fallback.
 */
export function libraryArtwork(service: ArrService, r: Raw | undefined, libraryId?: number, kind?: 'artist' | 'album'): { poster?: string; posterAlt?: string } {
  const img = pickImage(r?.images, ['poster', 'cover']);
  const remote = sizedRemote(img?.remoteUrl || r?.remotePoster || r?.remoteCover, 'poster');
  let local = localImage(service, img?.url, 250);
  if (!local && libraryId) {
    if (service === 'lidarr') local = kind === 'artist' ? `/api/artwork/lidarr/artist/${libraryId}/poster-250.jpg` : `/api/artwork/lidarr/album/${libraryId}/cover-250.jpg`;
    else if (service === 'readarr') local = `/api/artwork/readarr/book/${libraryId}/cover-250.jpg`;
    else local = `/api/artwork/${service}/${libraryId}/poster-250.jpg`;
  }
  return { poster: local || remote, posterAlt: local && remote !== local ? remote : undefined };
}

function pickImage(images: Raw[] | undefined, types: string[]): Raw | undefined {
  if (!images?.length) return undefined;
  for (const t of types) {
    const img = images.find((i) => String(i.coverType).toLowerCase() === t);
    if (img) return img;
  }
  return undefined;
}

function images(service: ArrService, r: Raw, inLibrary: boolean, posterTypes = ['poster', 'cover']): Pick<MediaItem, 'poster' | 'posterAlt' | 'fanart'> {
  const p = pickImage(r.images, posterTypes);
  const f = pickImage(r.images, ['fanart', 'banner']);
  const remotePoster = sizedRemote(p?.remoteUrl || r.remotePoster || r.remoteCover, 'poster');
  const remoteFanart = sizedRemote(f?.remoteUrl, 'fanart');
  if (inLibrary) {
    const local = localImage(service, p?.url, 500);
    return {
      poster: local || remotePoster,
      posterAlt: local ? remotePoster : undefined,
      // the *arr app caches artwork locally: works on a LAN without reaching TMDB/TVDB from the browser
      fanart: localImage(service, f?.url) || remoteFanart,
    };
  }
  return { poster: remotePoster, fanart: remoteFanart };
}

/* ------------------------------ helpers ------------------------------ */

function rating(r: Raw): number | undefined {
  const rt = r.ratings;
  if (!rt) return undefined;
  if (typeof rt.value === 'number' && rt.value > 0) return Math.round(rt.value * 10) / 10;
  const v = rt.imdb?.value ?? rt.tmdb?.value ?? rt.trakt?.value;
  return typeof v === 'number' && v > 0 ? Math.round(v * 10) / 10 : undefined;
}

function pct(have: number, total: number): number {
  return total > 0 ? Math.round((have / total) * 1000) / 10 : 0;
}

function availabilityFromCounts(have: number, total: number, unreleased: boolean): Availability {
  if (total <= 0) return unreleased ? 'unreleased' : have > 0 ? 'available' : 'missing';
  if (have >= total) return 'available';
  if (have > 0) return 'partial';
  return 'missing';
}

const strip = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

/* ------------------------------ movies ------------------------------ */

export function movieItem(m: Raw, opts: { libraryId?: number; withRaw?: boolean } = {}): MediaItem {
  const id = opts.libraryId ?? (m.id > 0 ? m.id : undefined);
  const inLibrary = !!id;
  const hasFile = !!(m.hasFile || m.movieFile || (m.statistics?.movieFileCount ?? 0) > 0);
  let availability: Availability = 'none';
  if (inLibrary) availability = hasFile ? 'available' : m.isAvailable === false || ['announced', 'tba'].includes(m.status) ? 'unreleased' : 'missing';
  return strip({
    key: `movie:tmdb:${m.tmdbId}`,
    kind: 'movie',
    service: 'radarr',
    id,
    inLibrary,
    title: m.title,
    sortTitle: m.sortTitle,
    subtitle: m.studio || undefined,
    year: m.year || undefined,
    overview: m.overview,
    ...images('radarr', m, inLibrary),
    genres: m.genres,
    runtime: m.runtime || undefined,
    rating: rating(m),
    certification: m.certification,
    status: m.status,
    monitored: inLibrary ? m.monitored : undefined,
    availability,
    sizeOnDisk: m.sizeOnDisk ?? m.statistics?.sizeOnDisk,
    added: inLibrary ? m.added : undefined,
    releaseDate: m.digitalRelease || m.physicalRelease || m.inCinemas || m.releaseDate,
    qualityProfileId: inLibrary ? m.qualityProfileId : undefined,
    path: inLibrary ? m.path : undefined,
    ids: strip({ tmdb: m.tmdbId, imdb: m.imdbId || undefined }),
    raw: opts.withRaw ? m : undefined,
  } as MediaItem);
}

/* ------------------------------ series ------------------------------ */

export function seriesItem(s: Raw, opts: { libraryId?: number; withRaw?: boolean } = {}): MediaItem {
  const id = opts.libraryId ?? (s.id > 0 ? s.id : undefined);
  const inLibrary = !!id;
  const st = s.statistics || {};
  const have = st.episodeFileCount ?? 0;
  const total = st.episodeCount ?? 0;
  return strip({
    key: `series:tvdb:${s.tvdbId}`,
    kind: 'series',
    service: 'sonarr',
    id,
    inLibrary,
    title: s.title,
    sortTitle: s.sortTitle,
    subtitle: s.network || undefined,
    year: s.year || undefined,
    overview: s.overview,
    ...images('sonarr', s, inLibrary),
    genres: s.genres,
    runtime: s.runtime || undefined,
    rating: rating(s),
    certification: s.certification,
    status: s.status,
    monitored: inLibrary ? s.monitored : undefined,
    availability: inLibrary ? availabilityFromCounts(have, total, s.status === 'upcoming') : 'none',
    progress: inLibrary ? { have, total, percent: pct(have, total) } : undefined,
    sizeOnDisk: st.sizeOnDisk,
    added: inLibrary ? s.added : undefined,
    releaseDate: s.firstAired,
    nextAiring: s.nextAiring,
    seasonCount: st.seasonCount ?? (s.seasons || []).filter((x: Raw) => x.seasonNumber > 0).length,
    qualityProfileId: inLibrary ? s.qualityProfileId : undefined,
    path: inLibrary ? s.path : undefined,
    ids: strip({ tvdb: s.tvdbId, tmdb: s.tmdbId || undefined, imdb: s.imdbId || undefined }),
    raw: opts.withRaw ? s : undefined,
  } as MediaItem);
}

export function seasonViews(series: Raw, episodes: Raw[]): SeasonView[] {
  const now = Date.now();
  const bySeason = new Map<number, EpisodeView[]>();
  for (const e of episodes) {
    const ev: EpisodeView = strip({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title,
      airDate: e.airDateUtc || e.airDate,
      overview: e.overview,
      hasFile: !!e.hasFile,
      monitored: !!e.monitored,
      aired: !!e.airDateUtc && Date.parse(e.airDateUtc) <= now,
      quality: e.episodeFile?.quality?.quality?.name,
      size: e.episodeFile?.size,
      finaleType: e.finaleType,
    });
    const list = bySeason.get(e.seasonNumber) || [];
    list.push(ev);
    bySeason.set(e.seasonNumber, list);
  }
  return (series.seasons || [])
    .map((s: Raw): SeasonView => ({
      seasonNumber: s.seasonNumber,
      monitored: !!s.monitored,
      episodeFileCount: s.statistics?.episodeFileCount ?? 0,
      episodeCount: s.statistics?.episodeCount ?? 0,
      totalEpisodeCount: s.statistics?.totalEpisodeCount ?? 0,
      sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
      episodes: (bySeason.get(s.seasonNumber) || []).sort((a, b) => b.episodeNumber - a.episodeNumber),
    }))
    .sort((a: SeasonView, b: SeasonView) => {
      // specials last
      if (a.seasonNumber === 0) return 1;
      if (b.seasonNumber === 0) return -1;
      return b.seasonNumber - a.seasonNumber;
    });
}

/* ------------------------------ music ------------------------------ */

export function artistItem(a: Raw, opts: { libraryId?: number; withRaw?: boolean } = {}): MediaItem {
  const id = opts.libraryId ?? (a.id > 0 ? a.id : undefined);
  const inLibrary = !!id;
  const st = a.statistics || {};
  const have = st.trackFileCount ?? 0;
  const total = st.trackCount ?? 0;
  return strip({
    key: `artist:mb:${a.foreignArtistId}`,
    kind: 'artist',
    service: 'lidarr',
    id,
    inLibrary,
    title: a.artistName,
    sortTitle: a.sortName,
    subtitle: a.disambiguation || a.artistType || undefined,
    overview: a.overview,
    ...images('lidarr', a, inLibrary, ['poster', 'cover', 'logo']),
    genres: a.genres,
    rating: rating(a),
    status: a.status,
    monitored: inLibrary ? a.monitored : undefined,
    availability: inLibrary ? availabilityFromCounts(have, total, false) : 'none',
    progress: inLibrary ? { have, total, percent: pct(have, total) } : undefined,
    sizeOnDisk: st.sizeOnDisk,
    added: inLibrary ? a.added : undefined,
    path: inLibrary ? a.path : undefined,
    ids: strip({ mb: a.foreignArtistId }),
    raw: opts.withRaw ? a : undefined,
  } as MediaItem);
}

export function albumItem(al: Raw, opts: { libraryId?: number; withRaw?: boolean; artistName?: string } = {}): MediaItem {
  const id = opts.libraryId ?? (al.id > 0 ? al.id : undefined);
  const inLibrary = !!id;
  const st = al.statistics || {};
  const have = st.trackFileCount ?? 0;
  const total = st.trackCount ?? 0;
  const released = !al.releaseDate || Date.parse(al.releaseDate) <= Date.now();
  const year = al.releaseDate ? new Date(al.releaseDate).getUTCFullYear() : undefined;
  return strip({
    key: `album:mb:${al.foreignAlbumId}`,
    kind: 'album',
    service: 'lidarr',
    id,
    inLibrary,
    title: al.title,
    subtitle: opts.artistName || al.artist?.artistName,
    year: year && year > 1000 ? year : undefined,
    overview: al.overview,
    ...images('lidarr', al, inLibrary, ['cover', 'poster', 'disc']),
    genres: al.genres,
    rating: rating(al),
    status: al.albumType,
    monitored: inLibrary ? al.monitored : undefined,
    availability: inLibrary ? availabilityFromCounts(have, total, !released) : 'none',
    progress: inLibrary ? { have, total, percent: pct(have, total) } : undefined,
    sizeOnDisk: st.sizeOnDisk,
    releaseDate: al.releaseDate,
    ids: strip({ mb: al.foreignAlbumId, foreign: al.artist?.foreignArtistId }),
    raw: opts.withRaw ? al : undefined,
  } as MediaItem);
}

/* ------------------------------ books ------------------------------ */

export function bookItem(b: Raw, opts: { libraryId?: number; withRaw?: boolean } = {}): MediaItem {
  const id = opts.libraryId ?? (b.id > 0 ? b.id : undefined);
  const inLibrary = !!id;
  const files = b.statistics?.bookFileCount ?? 0;
  const year = b.releaseDate ? new Date(b.releaseDate).getUTCFullYear() : undefined;
  return strip({
    key: `book:${b.foreignBookId}`,
    kind: 'book',
    service: 'readarr',
    id,
    inLibrary,
    title: b.title,
    subtitle: b.author?.authorName || b.authorTitle?.split(' ').reverse().join(' '),
    year: year && year > 1000 ? year : undefined,
    overview: b.overview,
    ...images('readarr', b, inLibrary, ['cover', 'poster']),
    genres: b.genres,
    rating: rating(b),
    monitored: inLibrary ? b.monitored : undefined,
    availability: inLibrary ? (files > 0 ? 'available' : 'missing') : 'none',
    sizeOnDisk: b.statistics?.sizeOnDisk,
    releaseDate: b.releaseDate,
    ids: strip({ foreign: b.foreignBookId }),
    raw: opts.withRaw ? b : undefined,
  } as MediaItem);
}

/* ------------------------------ files ------------------------------ */

export function movieFileView(f: Raw): FileView {
  const mi = f.mediaInfo || {};
  return strip({
    path: f.path || f.relativePath,
    size: f.size || 0,
    quality: f.quality?.quality?.name,
    resolution: mi.resolution,
    videoCodec: mi.videoCodec,
    audio: [mi.audioCodec, mi.audioChannels].filter(Boolean).join(' ') || undefined,
    languages: (f.languages || []).map((l: Raw) => l.name).filter(Boolean),
    subtitles: mi.subtitles ? String(mi.subtitles).split('/').map((s) => s.trim()).filter(Boolean) : undefined,
    dateAdded: f.dateAdded,
  });
}

