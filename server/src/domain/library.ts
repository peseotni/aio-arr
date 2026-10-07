/* Library + lookup operations over Radarr / Sonarr / Lidarr / Readarr. */
import { getSettings } from '../config.js';
import { cached, invalidate } from '../util/cache.js';
import { HttpError } from '../util/http.js';
import { need, services } from '../services/registry.js';
import type { ArrService as ArrBase, NamedId, Raw } from '../services/arr.js';
import type { ArrService, MediaDetail, MediaItem, ReleaseView } from '../types.js';
import { albumItem, artistItem, attachJellyfin, bookItem, movieFileView, movieItem, seasonViews, seriesItem } from './media.js';

const LIST_TTL = 30_000;

/* ------------------------------------------------------------------ */
/* Raw library lists (cached)                                          */
/* ------------------------------------------------------------------ */

export const rawMovies = () => cached('lib:radarr', LIST_TTL, () => need(services().radarr, 'Radarr').movies());
export const rawSeries = () => cached('lib:sonarr', LIST_TTL, () => need(services().sonarr, 'Sonarr').series());
export const rawArtists = () => cached('lib:lidarr:artists', LIST_TTL, () => need(services().lidarr, 'Lidarr').artists());
export const rawAlbums = () => cached('lib:lidarr:albums', LIST_TTL, () => need(services().lidarr, 'Lidarr').albums());
export const rawBooks = () => cached('lib:readarr', LIST_TTL, () => need(services().readarr, 'Readarr').books());

export function invalidateLibrary(service: ArrService): void {
  invalidate(`lib:${service}`, `wanted:${service}`, 'calendar:', `detail:${service}`);
  if (service === 'radarr' || service === 'sonarr' || service === 'lidarr') services().jellyfin?.invalidateIndex();
}

/* ------------------------------------------------------------------ */
/* Library listings                                                    */
/* ------------------------------------------------------------------ */

export async function listLibrary(kind: 'movie' | 'series' | 'artist' | 'album' | 'book'): Promise<MediaItem[]> {
  let items: MediaItem[];
  switch (kind) {
    case 'movie':
      items = (await rawMovies()).map((m) => movieItem(m));
      break;
    case 'series':
      items = (await rawSeries()).map((s) => seriesItem(s));
      break;
    case 'artist':
      items = (await rawArtists()).map((a) => artistItem(a));
      break;
    case 'album': {
      const artists = new Map((await rawArtists()).map((a) => [a.id, a.artistName as string]));
      items = (await rawAlbums()).map((al) => albumItem(al, { artistName: artists.get(al.artistId) }));
      break;
    }
    case 'book':
      items = (await rawBooks()).map((b) => bookItem(b));
      break;
  }
  // overview is only needed in detail views - keep list payloads small
  for (const it of items) delete it.overview;
  return attachJellyfin(items, services().jellyfin);
}

/* ------------------------------------------------------------------ */
/* Details                                                             */
/* ------------------------------------------------------------------ */

function serviceLinks(service: ArrService, path: string): { label: string; url: string }[] {
  const svc = services()[service];
  return svc ? [{ label: `Open in ${svc.name}`, url: `${svc.publicUrl}${path}` }] : [];
}

export async function movieDetail(id: number): Promise<MediaDetail> {
  const radarr = need(services().radarr, 'Radarr');
  const [m, files] = await Promise.all([radarr.movie(id), radarr.movieFiles(id).catch(() => [] as Raw[])]);
  const [item] = await attachJellyfin([movieItem(m)], services().jellyfin);
  return {
    item,
    files: files.map(movieFileView),
    links: [...serviceLinks('radarr', `/movie/${m.titleSlug || m.tmdbId}`), ...extLinks(item)],
  };
}

export async function seriesDetail(id: number): Promise<MediaDetail> {
  const sonarr = need(services().sonarr, 'Sonarr');
  const [s, episodes] = await Promise.all([sonarr.seriesById(id), sonarr.episodes(id)]);
  const [item] = await attachJellyfin([seriesItem(s)], services().jellyfin);
  return {
    item,
    seasons: seasonViews(s, episodes),
    links: [...serviceLinks('sonarr', `/series/${s.titleSlug}`), ...extLinks(item)],
  };
}

export async function artistDetail(id: number): Promise<MediaDetail> {
  const lidarr = need(services().lidarr, 'Lidarr');
  const [a, albums] = await Promise.all([lidarr.artist(id), lidarr.albums(id)]);
  const albumItems = albums
    .map((al) => albumItem(al, { artistName: a.artistName }))
    .sort((x, y) => String(y.releaseDate || '').localeCompare(String(x.releaseDate || '')));
  const [item] = await attachJellyfin([artistItem(a)], services().jellyfin);
  await attachJellyfin(albumItems, services().jellyfin);
  return {
    item,
    albums: albumItems,
    links: [...serviceLinks('lidarr', `/artist/${a.foreignArtistId}`), { label: 'MusicBrainz', url: `https://musicbrainz.org/artist/${a.foreignArtistId}` }],
  };
}

export async function bookDetail(id: number): Promise<MediaDetail> {
  const readarr = need(services().readarr, 'Readarr');
  const b = await readarr.book(id);
  return { item: bookItem(b), links: serviceLinks('readarr', `/book/${b.titleSlug || b.foreignBookId}`) };
}

function extLinks(item: MediaItem): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  if (item.ids.imdb) links.push({ label: 'IMDb', url: `https://www.imdb.com/title/${item.ids.imdb}/` });
  if (item.ids.tmdb) links.push({ label: 'TMDB', url: `https://www.themoviedb.org/${item.kind === 'movie' ? 'movie' : 'tv'}/${item.ids.tmdb}` });
  if (item.ids.tvdb && item.kind === 'series') links.push({ label: 'TheTVDB', url: `https://thetvdb.com/?tab=series&id=${item.ids.tvdb}` });
  return links;
}

/* ------------------------------------------------------------------ */
/* Search (lookup)                                                     */
/* ------------------------------------------------------------------ */

export interface SearchSection {
  items: MediaItem[];
  error?: string;
}

export interface SearchResponse {
  movies?: SearchSection;
  series?: SearchSection;
  artists?: SearchSection;
  albums?: SearchSection;
  books?: SearchSection;
}

async function section(fn: () => Promise<MediaItem[]>): Promise<SearchSection> {
  try {
    return { items: await fn() };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function searchAll(term: string, kinds: string[]): Promise<SearchResponse> {
  const s = services();
  const want = (k: string) => !kinds.length || kinds.includes(k);
  const tasks: Promise<void>[] = [];
  const out: SearchResponse = {};

  if (s.radarr && want('movie')) {
    tasks.push(
      section(async () => {
        const [results, lib] = await Promise.all([s.radarr!.lookup(term), rawMovies().catch(() => [] as Raw[])]);
        const ids = new Map(lib.map((m) => [m.tmdbId, m]));
        return results.slice(0, 30).map((m) => {
          const existing = ids.get(m.tmdbId);
          return existing ? movieItem(existing) : movieItem(m, { withRaw: true });
        });
      }).then((r) => void (out.movies = r)),
    );
  }
  if (s.sonarr && want('series')) {
    tasks.push(
      section(async () => {
        const [results, lib] = await Promise.all([s.sonarr!.lookup(term), rawSeries().catch(() => [] as Raw[])]);
        const ids = new Map(lib.map((x) => [x.tvdbId, x]));
        return results.slice(0, 30).map((x) => {
          const existing = ids.get(x.tvdbId);
          return existing ? seriesItem(existing) : seriesItem(x, { withRaw: true });
        });
      }).then((r) => void (out.series = r)),
    );
  }
  if (s.lidarr && (want('artist') || want('album'))) {
    const lidarrResults = section(async () => {
      const [results, artists, albums] = await Promise.all([
        s.lidarr!.search(term),
        rawArtists().catch(() => [] as Raw[]),
        rawAlbums().catch(() => [] as Raw[]),
      ]);
      const artistIds = new Map(artists.map((a) => [a.foreignArtistId, a]));
      const albumIds = new Map(albums.map((a) => [a.foreignAlbumId, a]));
      const items: MediaItem[] = [];
      for (const r of results.slice(0, 40)) {
        if (r.artist) {
          const ex = artistIds.get(r.artist.foreignArtistId);
          items.push(ex ? artistItem(ex) : artistItem(r.artist, { withRaw: true }));
        } else if (r.album) {
          const ex = albumIds.get(r.album.foreignAlbumId);
          items.push(ex ? albumItem(ex, { artistName: artistIds.get(ex.artist?.foreignArtistId)?.artistName || r.album.artist?.artistName }) : albumItem(r.album, { withRaw: true }));
        }
      }
      return items;
    });
    tasks.push(
      lidarrResults.then((r) => {
        out.artists = { items: r.items.filter((i) => i.kind === 'artist'), error: r.error };
        out.albums = { items: r.items.filter((i) => i.kind === 'album'), error: r.error };
      }),
    );
  }
  if (s.readarr && want('book')) {
    tasks.push(
      section(async () => {
        const [results, lib] = await Promise.all([s.readarr!.search(term), rawBooks().catch(() => [] as Raw[])]);
        const ids = new Map(lib.map((b) => [b.foreignBookId, b]));
        return results
          .filter((r) => r.book)
          .slice(0, 30)
          .map((r) => {
            const ex = ids.get(r.book.foreignBookId);
            return ex ? bookItem(ex) : bookItem(r.book, { withRaw: true });
          });
      }).then((r) => void (out.books = r)),
    );
  }
  await Promise.all(tasks);
  const jf = s.jellyfin;
  await Promise.all(
    [out.movies, out.series, out.artists, out.albums].filter((x): x is SearchSection => !!x).map((sec) => attachJellyfin(sec.items, jf)),
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Add options                                                         */
/* ------------------------------------------------------------------ */

export interface AddOptions {
  qualityProfiles: NamedId[];
  metadataProfiles?: NamedId[];
  rootFolders: { path: string; freeSpace?: number }[];
  defaults: {
    qualityProfileId?: number;
    metadataProfileId?: number;
    rootFolderPath?: string;
    monitor?: string;
    minimumAvailability?: string;
    seriesType?: string;
    searchOnAdd: boolean;
  };
}

function arrFor(service: ArrService): ArrBase {
  const svc = services()[service];
  if (!svc) throw new HttpError(`${service} is not configured`, 409);
  return svc;
}

export function addOptions(service: ArrService): Promise<AddOptions> {
  return cached(`opts:${service}`, 60_000, async () => {
    const svc = arrFor(service);
    const withMeta = service === 'lidarr' || service === 'readarr';
    const [qualityProfiles, rootFolders, metadataProfiles] = await Promise.all([
      svc.qualityProfiles(),
      svc.rootFolders(),
      withMeta ? (svc as unknown as { metadataProfiles(): Promise<NamedId[]> }).metadataProfiles() : Promise.resolve(undefined),
    ]);
    const d = getSettings().services[service].defaults || {};
    const firstRoot = rootFolders[0];
    return {
      qualityProfiles: qualityProfiles.map(({ id, name }) => ({ id, name })),
      metadataProfiles: metadataProfiles?.map(({ id, name }) => ({ id, name })),
      rootFolders: rootFolders.map((r) => ({ path: r.path, freeSpace: r.freeSpace })),
      defaults: {
        qualityProfileId:
          (d.qualityProfileId && qualityProfiles.some((q) => q.id === d.qualityProfileId) ? d.qualityProfileId : undefined) ??
          firstRoot?.defaultQualityProfileId ??
          qualityProfiles[0]?.id,
        metadataProfileId:
          (d.metadataProfileId && metadataProfiles?.some((q) => q.id === d.metadataProfileId) ? d.metadataProfileId : undefined) ??
          firstRoot?.defaultMetadataProfileId ??
          metadataProfiles?.find((p) => p.name !== 'None')?.id,
        rootFolderPath: (d.rootFolderPath && rootFolders.some((r) => r.path === d.rootFolderPath) ? d.rootFolderPath : undefined) ?? firstRoot?.path,
        monitor: d.monitor || 'all',
        minimumAvailability: d.minimumAvailability || 'released',
        seriesType: d.seriesType || 'standard',
        searchOnAdd: d.searchOnAdd !== false,
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Add                                                                 */
/* ------------------------------------------------------------------ */

export interface AddRequest {
  raw: Raw;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  monitor?: string;
  minimumAvailability?: string;
  seriesType?: string;
  search?: boolean;
}

function requireRoot(opts: AddOptions, req: AddRequest, name: string): string {
  const root = req.rootFolderPath || opts.defaults.rootFolderPath;
  if (!root) throw new HttpError(`${name} has no root folder. Add one in ${name} (Settings > Media Management).`, 409);
  return root;
}

export async function addMedia(kind: 'movie' | 'series' | 'artist' | 'album' | 'book', req: AddRequest): Promise<MediaItem> {
  if (!req.raw || typeof req.raw !== 'object') throw new HttpError('Missing item data', 400);
  const raw = { ...req.raw };
  delete raw.id;
  switch (kind) {
    case 'movie': {
      const radarr = need(services().radarr, 'Radarr');
      const o = await addOptions('radarr');
      const search = req.search ?? o.defaults.searchOnAdd;
      const added = await radarr.addMovie({
        ...raw,
        qualityProfileId: req.qualityProfileId ?? o.defaults.qualityProfileId,
        rootFolderPath: requireRoot(o, req, 'Radarr'),
        monitored: true,
        minimumAvailability: req.minimumAvailability ?? o.defaults.minimumAvailability,
        tags: [],
        addOptions: { searchForMovie: search, monitor: 'movieOnly' },
      });
      invalidateLibrary('radarr');
      return movieItem(added);
    }
    case 'series': {
      const sonarr = need(services().sonarr, 'Sonarr');
      const o = await addOptions('sonarr');
      const search = req.search ?? o.defaults.searchOnAdd;
      const added = await sonarr.addSeries({
        ...raw,
        qualityProfileId: req.qualityProfileId ?? o.defaults.qualityProfileId,
        rootFolderPath: requireRoot(o, req, 'Sonarr'),
        monitored: true,
        seasonFolder: true,
        seriesType: req.seriesType ?? o.defaults.seriesType,
        tags: [],
        addOptions: {
          monitor: req.monitor ?? o.defaults.monitor ?? 'all',
          searchForMissingEpisodes: search,
          searchForCutoffUnmetEpisodes: false,
        },
      });
      invalidateLibrary('sonarr');
      return seriesItem(added);
    }
    case 'artist': {
      const lidarr = need(services().lidarr, 'Lidarr');
      const o = await addOptions('lidarr');
      const search = req.search ?? o.defaults.searchOnAdd;
      const added = await lidarr.addArtist({
        ...raw,
        qualityProfileId: req.qualityProfileId ?? o.defaults.qualityProfileId,
        metadataProfileId: req.metadataProfileId ?? o.defaults.metadataProfileId,
        rootFolderPath: requireRoot(o, req, 'Lidarr'),
        monitored: true,
        monitorNewItems: 'all',
        tags: [],
        addOptions: { monitor: req.monitor ?? o.defaults.monitor ?? 'all', searchForMissingAlbums: search },
      });
      invalidateLibrary('lidarr');
      return artistItem(added);
    }
    case 'album': {
      const lidarr = need(services().lidarr, 'Lidarr');
      const o = await addOptions('lidarr');
      const search = req.search ?? o.defaults.searchOnAdd;
      const artist = (raw.artist || {}) as Raw;
      const existing = (await rawArtists().catch(() => [] as Raw[])).find((a) => a.foreignArtistId === artist.foreignArtistId);
      const added = await lidarr.addAlbum({
        ...raw,
        monitored: true,
        anyReleaseOk: true,
        artist: existing
          ? existing
          : {
              ...artist,
              qualityProfileId: req.qualityProfileId ?? o.defaults.qualityProfileId,
              metadataProfileId: req.metadataProfileId ?? o.defaults.metadataProfileId,
              rootFolderPath: requireRoot(o, req, 'Lidarr'),
              monitored: true,
              monitorNewItems: 'none',
              tags: [],
              addOptions: { monitor: 'none', searchForMissingAlbums: false },
            },
        addOptions: { searchForNewAlbum: search },
      });
      invalidateLibrary('lidarr');
      return albumItem(added);
    }
    case 'book': {
      const readarr = need(services().readarr, 'Readarr');
      const o = await addOptions('readarr');
      const search = req.search ?? o.defaults.searchOnAdd;
      const author = (raw.author || {}) as Raw;
      const added = await readarr.addBook({
        ...raw,
        monitored: true,
        anyEditionOk: true,
        author: {
          ...author,
          qualityProfileId: req.qualityProfileId ?? o.defaults.qualityProfileId,
          metadataProfileId: req.metadataProfileId ?? o.defaults.metadataProfileId,
          rootFolderPath: requireRoot(o, req, 'Readarr'),
          monitored: true,
          tags: [],
          addOptions: { monitor: 'none', searchForMissingBooks: false },
        },
        addOptions: { searchForNewBook: search },
      });
      invalidateLibrary('readarr');
      return bookItem(added);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export async function searchNow(kind: string, id: number, extra: { seasonNumber?: number; episodeIds?: number[]; albumIds?: number[] } = {}): Promise<void> {
  const s = services();
  switch (kind) {
    case 'movie':
      await need(s.radarr, 'Radarr').command('MoviesSearch', { movieIds: [id] });
      return;
    case 'series':
      if (extra.episodeIds?.length) await need(s.sonarr, 'Sonarr').command('EpisodeSearch', { episodeIds: extra.episodeIds });
      else if (extra.seasonNumber !== undefined) await need(s.sonarr, 'Sonarr').command('SeasonSearch', { seriesId: id, seasonNumber: extra.seasonNumber });
      else await need(s.sonarr, 'Sonarr').command('SeriesSearch', { seriesId: id });
      return;
    case 'artist':
      if (extra.albumIds?.length) await need(s.lidarr, 'Lidarr').command('AlbumSearch', { albumIds: extra.albumIds });
      else await need(s.lidarr, 'Lidarr').command('ArtistSearch', { artistId: id });
      return;
    case 'album':
      await need(s.lidarr, 'Lidarr').command('AlbumSearch', { albumIds: [id] });
      return;
    case 'book':
      await need(s.readarr, 'Readarr').command('BookSearch', { bookIds: [id] });
      return;
  }
  throw new HttpError(`Unknown media kind ${kind}`, 400);
}

export async function setMonitored(
  kind: string,
  id: number,
  monitored: boolean,
  extra: { seasonNumber?: number; episodeIds?: number[]; albumIds?: number[] } = {},
): Promise<void> {
  const s = services();
  switch (kind) {
    case 'movie': {
      const radarr = need(s.radarr, 'Radarr');
      const m = await radarr.movie(id);
      await radarr.updateMovie({ ...m, monitored });
      invalidateLibrary('radarr');
      return;
    }
    case 'series': {
      const sonarr = need(s.sonarr, 'Sonarr');
      if (extra.episodeIds?.length) {
        await sonarr.monitorEpisodes(extra.episodeIds, monitored);
      } else {
        const series = await sonarr.seriesById(id);
        if (extra.seasonNumber !== undefined) {
          series.seasons = (series.seasons || []).map((x: Raw) => (x.seasonNumber === extra.seasonNumber ? { ...x, monitored } : x));
        } else {
          series.monitored = monitored;
        }
        await sonarr.updateSeries(series);
      }
      invalidateLibrary('sonarr');
      return;
    }
    case 'artist': {
      const lidarr = need(s.lidarr, 'Lidarr');
      if (extra.albumIds?.length) await lidarr.monitorAlbums(extra.albumIds, monitored);
      else {
        const a = await lidarr.artist(id);
        await lidarr.updateArtist({ ...a, monitored });
      }
      invalidateLibrary('lidarr');
      return;
    }
    case 'album':
      await need(s.lidarr, 'Lidarr').monitorAlbums([id], monitored);
      invalidateLibrary('lidarr');
      return;
    case 'book':
      await need(s.readarr, 'Readarr').monitorBooks([id], monitored);
      invalidateLibrary('readarr');
      return;
  }
  throw new HttpError(`Unknown media kind ${kind}`, 400);
}

export async function deleteMedia(kind: string, id: number, deleteFiles: boolean): Promise<void> {
  const s = services();
  switch (kind) {
    case 'movie':
      await need(s.radarr, 'Radarr').deleteMovie(id, deleteFiles);
      invalidateLibrary('radarr');
      return;
    case 'series':
      await need(s.sonarr, 'Sonarr').deleteSeries(id, deleteFiles);
      invalidateLibrary('sonarr');
      return;
    case 'artist':
      await need(s.lidarr, 'Lidarr').deleteArtist(id, deleteFiles);
      invalidateLibrary('lidarr');
      return;
    case 'book':
      await need(s.readarr, 'Readarr').deleteBook(id, deleteFiles);
      invalidateLibrary('readarr');
      return;
  }
  throw new HttpError(`Cannot delete ${kind}`, 400);
}

/* ------------------------------------------------------------------ */
/* Interactive release search                                          */
/* ------------------------------------------------------------------ */

export function releaseView(r: Raw): ReleaseView {
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexer,
    title: r.title,
    size: r.size || 0,
    protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
    seeders: r.seeders ?? undefined,
    leechers: r.leechers ?? undefined,
    ageHours: typeof r.ageHours === 'number' ? Math.round(r.ageHours) : typeof r.age === 'number' ? r.age * 24 : undefined,
    publishDate: r.publishDate,
    quality: r.quality?.quality?.name,
    customFormatScore: r.customFormatScore,
    languages: (r.languages || []).map((l: Raw) => l.name).filter(Boolean),
    rejected: !!r.rejected,
    rejections: r.rejections || [],
    approved: !!r.approved,
    infoUrl: r.infoUrl || r.commentUrl || undefined,
  };
}

export async function releasesFor(kind: string, id: number, extra: { seasonNumber?: number; episodeId?: number } = {}): Promise<ReleaseView[]> {
  const s = services();
  let list: Raw[];
  switch (kind) {
    case 'movie':
      list = await need(s.radarr, 'Radarr').releases({ movieId: id });
      break;
    case 'series':
      list = await need(s.sonarr, 'Sonarr').releases(
        extra.episodeId ? { episodeId: extra.episodeId } : { seriesId: id, seasonNumber: extra.seasonNumber ?? 1 },
      );
      break;
    case 'album':
      list = await need(s.lidarr, 'Lidarr').releases({ albumId: id });
      break;
    case 'book':
      list = await need(s.readarr, 'Readarr').releases({ bookId: id });
      break;
    default:
      throw new HttpError(`Interactive search is not available for ${kind}`, 400);
  }
  return list.map(releaseView).sort((a, b) => {
    if (!!a.rejected !== !!b.rejected) return a.rejected ? 1 : -1;
    return 0; // keep the *arr's own ranking otherwise
  });
}

export async function grabArrRelease(service: ArrService, guid: string, indexerId: number): Promise<void> {
  const svc = arrFor(service);
  await svc.grabRelease(guid, indexerId);
  invalidate('downloads');
}
