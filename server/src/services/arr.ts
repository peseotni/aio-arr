/* Clients for the Servarr family: Radarr, Sonarr, Lidarr, Readarr and Prowlarr. */
import { BaseService, type TestResult } from './base.js';
import type { RequestOptions } from '../util/http.js';

// The *arr resources are large; we only type what we use and pass the rest through.
export type Raw = Record<string, any>;

export interface Paged<T> {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: T[];
}

export interface ArrStatus {
  appName?: string;
  instanceName?: string;
  version: string;
  urlBase?: string;
}

export interface ArrHealth {
  source: string;
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  wikiUrl?: string;
}

export interface ArrDisk {
  path: string;
  label?: string;
  freeSpace: number;
  totalSpace: number;
}

export interface ArrRootFolder {
  id: number;
  path: string;
  accessible?: boolean;
  freeSpace?: number;
  name?: string;
  defaultQualityProfileId?: number;
  defaultMetadataProfileId?: number;
}

export interface NamedId {
  id: number;
  name: string;
}

export abstract class ArrService extends BaseService {
  abstract readonly apiVersion: 'v1' | 'v3';

  override headers(): Record<string, string> {
    return { 'X-Api-Key': this.cfg.apiKey };
  }

  api<T = any>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(`/api/${this.apiVersion}/${path.replace(/^\/+/, '')}`, opts);
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error(`${this.name}: an API key is required (Settings > General in ${this.name})`);
    const s = await this.status();
    return { ok: true, version: s.version, message: `${s.appName || this.name} ${s.version}` };
  }

  status(): Promise<ArrStatus> {
    return this.api('system/status', { timeoutMs: 10000 });
  }

  health(): Promise<ArrHealth[]> {
    return this.api('health', { timeoutMs: 10000 });
  }

  diskspace(): Promise<ArrDisk[]> {
    return this.api('diskspace', { timeoutMs: 15000 });
  }

  rootFolders(): Promise<ArrRootFolder[]> {
    return this.api('rootfolder');
  }

  qualityProfiles(): Promise<NamedId[]> {
    return this.api('qualityprofile');
  }

  tags(): Promise<{ id: number; label: string }[]> {
    return this.api('tag');
  }

  queue(query: Record<string, string | number | boolean> = {}): Promise<Paged<Raw>> {
    return this.api('queue', { query: { page: 1, pageSize: 250, ...query } });
  }

  removeQueueItem(id: number, opts: { removeFromClient: boolean; blocklist: boolean; skipRedownload?: boolean }): Promise<void> {
    return this.api(`queue/${id}`, {
      method: 'DELETE',
      query: { removeFromClient: opts.removeFromClient, blocklist: opts.blocklist, skipRedownload: opts.skipRedownload ?? false },
    });
  }

  history(query: Record<string, string | number | boolean> = {}): Promise<Paged<Raw>> {
    return this.api('history', { query: { page: 1, pageSize: 50, sortKey: 'date', sortDirection: 'descending', ...query } });
  }

  command(name: string, body: Record<string, unknown> = {}): Promise<Raw> {
    return this.api('command', { method: 'POST', body: { name, ...body } });
  }

  calendar(start: string, end: string, extra: Record<string, string | number | boolean> = {}): Promise<Raw[]> {
    return this.api('calendar', { query: { start, end, unmonitored: false, ...extra } });
  }

  /** Interactive search - can take a while because every indexer is queried. */
  releases(query: Record<string, string | number>): Promise<Raw[]> {
    return this.api('release', { query, timeoutMs: 180000 });
  }

  grabRelease(guid: string, indexerId: number): Promise<Raw> {
    return this.api('release', { method: 'POST', body: { guid, indexerId }, timeoutMs: 60000 });
  }

  wantedMissing(query: Record<string, string | number | boolean> = {}): Promise<Paged<Raw>> {
    return this.api('wanted/missing', { query: { page: 1, pageSize: 50, monitored: true, ...query } });
  }

  /** Raw image response for /api/vX/mediacover/... */
  mediaCover(path: string): Promise<Response> {
    return this.api(`mediacover/${path.replace(/^\/+/, '')}`, { responseType: 'raw', timeoutMs: 20000 });
  }
}

/* ------------------------------------------------------------------ */

export class RadarrService extends ArrService {
  readonly apiVersion = 'v3' as const;

  movies(): Promise<Raw[]> {
    return this.api('movie', { timeoutMs: 60000 });
  }

  movie(id: number): Promise<Raw> {
    return this.api(`movie/${id}`);
  }

  lookup(term: string): Promise<Raw[]> {
    return this.api('movie/lookup', { query: { term }, timeoutMs: 30000 });
  }

  lookupTmdb(tmdbId: number): Promise<Raw> {
    return this.api('movie/lookup/tmdb', { query: { tmdbId }, timeoutMs: 30000 });
  }

  addMovie(movie: Raw): Promise<Raw> {
    return this.api('movie', { method: 'POST', body: movie, timeoutMs: 60000 });
  }

  updateMovie(movie: Raw): Promise<Raw> {
    return this.api(`movie/${movie.id}`, { method: 'PUT', body: movie });
  }

  deleteMovie(id: number, deleteFiles: boolean, addImportExclusion = false): Promise<void> {
    return this.api(`movie/${id}`, { method: 'DELETE', query: { deleteFiles, addImportExclusion } });
  }

  movieFiles(movieId: number): Promise<Raw[]> {
    return this.api('moviefile', { query: { movieId } });
  }

  discover(): Promise<Raw[]> {
    return this.api('importlist/movie', {
      query: { includeRecommendations: true, includeTrending: true, includePopular: true },
      timeoutMs: 30000,
    });
  }

  movieHistory(movieId: number): Promise<Raw[]> {
    return this.api('history/movie', { query: { movieId } });
  }
}

/* ------------------------------------------------------------------ */

export class SonarrService extends ArrService {
  readonly apiVersion = 'v3' as const;

  series(): Promise<Raw[]> {
    return this.api('series', { timeoutMs: 60000 });
  }

  seriesById(id: number): Promise<Raw> {
    return this.api(`series/${id}`);
  }

  lookup(term: string): Promise<Raw[]> {
    return this.api('series/lookup', { query: { term }, timeoutMs: 30000 });
  }

  addSeries(series: Raw): Promise<Raw> {
    return this.api('series', { method: 'POST', body: series, timeoutMs: 60000 });
  }

  updateSeries(series: Raw): Promise<Raw> {
    return this.api(`series/${series.id}`, { method: 'PUT', body: series });
  }

  deleteSeries(id: number, deleteFiles: boolean, addImportListExclusion = false): Promise<void> {
    return this.api(`series/${id}`, { method: 'DELETE', query: { deleteFiles, addImportListExclusion } });
  }

  episodes(seriesId: number): Promise<Raw[]> {
    return this.api('episode', { query: { seriesId, includeEpisodeFile: true }, timeoutMs: 30000 });
  }

  monitorEpisodes(episodeIds: number[], monitored: boolean): Promise<void> {
    return this.api('episode/monitor', { method: 'PUT', body: { episodeIds, monitored } });
  }
}

/* ------------------------------------------------------------------ */

export class LidarrService extends ArrService {
  readonly apiVersion = 'v1' as const;

  metadataProfiles(): Promise<NamedId[]> {
    return this.api('metadataprofile');
  }

  artists(): Promise<Raw[]> {
    return this.api('artist', { timeoutMs: 60000 });
  }

  artist(id: number): Promise<Raw> {
    return this.api(`artist/${id}`);
  }

  albums(artistId?: number): Promise<Raw[]> {
    return this.api('album', { query: artistId ? { artistId } : {}, timeoutMs: 60000 });
  }

  album(id: number): Promise<Raw> {
    return this.api(`album/${id}`);
  }

  /** Mixed artist + album search. */
  search(term: string): Promise<Raw[]> {
    return this.api('search', { query: { term }, timeoutMs: 30000 });
  }

  addArtist(artist: Raw): Promise<Raw> {
    return this.api('artist', { method: 'POST', body: artist, timeoutMs: 60000 });
  }

  addAlbum(album: Raw): Promise<Raw> {
    return this.api('album', { method: 'POST', body: album, timeoutMs: 60000 });
  }

  updateArtist(artist: Raw): Promise<Raw> {
    return this.api(`artist/${artist.id}`, { method: 'PUT', body: artist });
  }

  deleteArtist(id: number, deleteFiles: boolean): Promise<void> {
    return this.api(`artist/${id}`, { method: 'DELETE', query: { deleteFiles } });
  }

  monitorAlbums(albumIds: number[], monitored: boolean): Promise<void> {
    return this.api('album/monitor', { method: 'PUT', body: { albumIds, monitored } });
  }
}

/* ------------------------------------------------------------------ */

export class ReadarrService extends ArrService {
  readonly apiVersion = 'v1' as const;

  metadataProfiles(): Promise<NamedId[]> {
    return this.api('metadataprofile');
  }

  authors(): Promise<Raw[]> {
    return this.api('author', { timeoutMs: 60000 });
  }

  books(): Promise<Raw[]> {
    return this.api('book', { timeoutMs: 60000 });
  }

  book(id: number): Promise<Raw> {
    return this.api(`book/${id}`);
  }

  search(term: string): Promise<Raw[]> {
    return this.api('search', { query: { term }, timeoutMs: 30000 });
  }

  addBook(book: Raw): Promise<Raw> {
    return this.api('book', { method: 'POST', body: book, timeoutMs: 60000 });
  }

  deleteBook(id: number, deleteFiles: boolean): Promise<void> {
    return this.api(`book/${id}`, { method: 'DELETE', query: { deleteFiles } });
  }

  monitorBooks(bookIds: number[], monitored: boolean): Promise<void> {
    return this.api('book/monitor', { method: 'PUT', body: { bookIds, monitored } });
  }
}

/* ------------------------------------------------------------------ */

export class ProwlarrService extends ArrService {
  readonly apiVersion = 'v1' as const;

  search(query: string, categories: number[] = [], limit = 100): Promise<Raw[]> {
    return this.api('search', {
      query: { query, type: 'search', categories, limit },
      timeoutMs: 90000,
    });
  }

  /** Let Prowlarr send the release to its own download client. */
  grab(guid: string, indexerId: number): Promise<Raw> {
    return this.api('search', { method: 'POST', body: { guid, indexerId }, timeoutMs: 60000 });
  }

  indexers(): Promise<Raw[]> {
    return this.api('indexer');
  }

  indexerStatus(): Promise<Raw[]> {
    return this.api('indexerstatus');
  }

  downloadClients(): Promise<Raw[]> {
    return this.api('downloadclient');
  }

  /** Download a .torrent / .nzb through Prowlarr (link from a search result). Follows redirects manually. */
  async fetchRelease(downloadUrl: string): Promise<{ magnet?: string; data?: Buffer; fileName?: string; contentType?: string }> {
    let url = this.rewriteToBase(downloadUrl);
    for (let hop = 0; hop < 5; hop++) {
      const sameHost = url.startsWith(this.baseUrl);
      const res = await fetch(url, {
        headers: sameHost ? this.headers() : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Indexer redirect without location');
        if (loc.startsWith('magnet:')) return { magnet: loc };
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Could not download release (HTTP ${res.status}) ${text.slice(0, 200)}`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      const disposition = res.headers.get('content-disposition') || '';
      const fileName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const text = data.subarray(0, 64).toString('utf8').trim();
      if (text.startsWith('magnet:')) return { magnet: data.toString('utf8').trim() };
      return { data, fileName: fileName ? decodeURIComponent(fileName) : undefined, contentType: res.headers.get('content-type') || undefined };
    }
    throw new Error('Too many redirects while downloading release');
  }

  /**
   * Prowlarr builds download links from the Host header it saw. If that is not reachable from here
   * (e.g. a public hostname), re-point the link at the configured internal URL.
   */
  private rewriteToBase(link: string): string {
    try {
      const u = new URL(link);
      const base = new URL(this.baseUrl);
      const basePath = base.pathname.replace(/\/+$/, '');
      if (/\/\d+\/download$/.test(u.pathname) || u.pathname.includes('/api/v1/indexer/')) {
        const idx = u.pathname.search(/\/(\d+\/download|api\/v1\/indexer\/)/);
        const rest = u.pathname.slice(idx);
        return `${base.origin}${basePath}${rest}${u.search}`;
      }
    } catch {
      /* not a URL we know */
    }
    return link;
  }
}
