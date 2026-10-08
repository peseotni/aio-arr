/* Recommendation sources: TMDB (free API key) and Jellyseerr / Overseerr (which proxy TMDB). */
import { BaseService, type TestResult } from './base.js';
import type { RequestOptions } from '../util/http.js';

type Raw = Record<string, any>;

/** A recommended movie or show, whatever the source. */
export interface RecItem {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  poster?: string;
  fanart?: string;
  rating?: number;
  popularity?: number;
}

export interface RecommendationSource {
  readonly id: 'tmdb' | 'jellyseerr';
  readonly name: string;
  movieRecommendations(tmdbId: number): Promise<RecItem[]>;
  tvRecommendations(tmdbId: number): Promise<RecItem[]>;
  /** TVDB id of a TMDB show (Sonarr adds shows by TVDB id) */
  tvdbForShow(tmdbId: number): Promise<number | undefined>;
}

export const tmdbImage = (p: string | null | undefined, size = 'w342'): string | undefined => (p ? `https://image.tmdb.org/t/p/${size}${p.startsWith('/') ? '' : '/'}${p}` : undefined);

const yearOf = (d?: string | null) => {
  const y = d ? Number(String(d).slice(0, 4)) : NaN;
  return y > 1800 ? y : undefined;
};

/** TMDB and Jellyseerr results differ only in casing. */
export function recItem(r: Raw, kind: 'movie' | 'series'): RecItem | undefined {
  const id = Number(r.id);
  const title = kind === 'movie' ? r.title || r.original_title || r.originalTitle : r.name || r.original_name || r.originalName;
  if (!id || !title) return undefined;
  return {
    kind,
    tmdbId: id,
    title,
    year: yearOf(kind === 'movie' ? r.release_date ?? r.releaseDate : r.first_air_date ?? r.firstAirDate),
    overview: r.overview || undefined,
    poster: tmdbImage(r.poster_path ?? r.posterPath),
    fanart: tmdbImage(r.backdrop_path ?? r.backdropPath, 'w1280'),
    rating: typeof (r.vote_average ?? r.voteAverage) === 'number' && (r.vote_average ?? r.voteAverage) > 0 ? Math.round((r.vote_average ?? r.voteAverage) * 10) / 10 : undefined,
    popularity: r.popularity,
  };
}

const list = (res: Raw | undefined, kind: 'movie' | 'series') => ((res?.results || []) as Raw[]).map((r) => recItem(r, kind)).filter((x): x is RecItem => !!x);

/* ------------------------------------------------------------------ */

export class TmdbService extends BaseService implements RecommendationSource {
  override readonly id = 'tmdb' as const;

  /** v4 "read access tokens" are JWTs, v3 keys are 32 hex characters. */
  private get bearer(): boolean {
    return this.cfg.apiKey.startsWith('eyJ');
  }

  override headers(): Record<string, string> {
    return this.bearer ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  override request<T = any>(p: string, opts: RequestOptions = {}): Promise<T> {
    const query = this.bearer ? opts.query : { ...opts.query, api_key: this.cfg.apiKey };
    return super.request<T>(p, { timeoutMs: 15000, ...opts, query });
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('TMDB: an API key is required (themoviedb.org > Settings > API)');
    await this.request('/configuration');
    return { ok: true, message: 'TMDB API key works' };
  }

  async movieRecommendations(tmdbId: number): Promise<RecItem[]> {
    return list(await this.request(`/movie/${tmdbId}/recommendations`, { query: { page: 1 } }), 'movie');
  }

  async tvRecommendations(tmdbId: number): Promise<RecItem[]> {
    return list(await this.request(`/tv/${tmdbId}/recommendations`, { query: { page: 1 } }), 'series');
  }

  async tvdbForShow(tmdbId: number): Promise<number | undefined> {
    const r = await this.request<Raw>(`/tv/${tmdbId}/external_ids`);
    return Number(r?.tvdb_id) || undefined;
  }

  /** TMDB id of a show known by its TVDB id */
  async showByTvdb(tvdbId: number): Promise<number | undefined> {
    const r = await this.request<Raw>(`/find/${tvdbId}`, { query: { external_source: 'tvdb_id' } });
    return Number(r?.tv_results?.[0]?.id) || undefined;
  }

  async searchMovie(query: string, year?: number): Promise<RecItem[]> {
    return list(await this.request('/search/movie', { query: { query, year } }), 'movie');
  }

  async searchTv(query: string, year?: number): Promise<RecItem[]> {
    return list(await this.request('/search/tv', { query: { query, first_air_date_year: year } }), 'series');
  }
}

/* ------------------------------------------------------------------ */

export class JellyseerrService extends BaseService implements RecommendationSource {
  override readonly id = 'jellyseerr' as const;

  override headers(): Record<string, string> {
    return { 'X-Api-Key': this.cfg.apiKey };
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('Jellyseerr: an API key is required (Settings > General > API Key)');
    const [status, me] = await Promise.all([this.request<Raw>('/api/v1/status', { timeoutMs: 10000 }), this.request<Raw>('/api/v1/auth/me', { timeoutMs: 10000 })]);
    return { ok: true, version: status?.version, message: `${this.name} ${status?.version || ''} (${me?.displayName || me?.username || me?.email || 'API key'})`.replace(/\s+/g, ' ') };
  }

  async movieRecommendations(tmdbId: number): Promise<RecItem[]> {
    return list(await this.request(`/api/v1/movie/${tmdbId}/recommendations`, { query: { page: 1 }, timeoutMs: 20000 }), 'movie');
  }

  async tvRecommendations(tmdbId: number): Promise<RecItem[]> {
    return list(await this.request(`/api/v1/tv/${tmdbId}/recommendations`, { query: { page: 1 }, timeoutMs: 20000 }), 'series');
  }

  async tvdbForShow(tmdbId: number): Promise<number | undefined> {
    const r = await this.request<Raw>(`/api/v1/tv/${tmdbId}`, { timeoutMs: 20000 });
    return Number(r?.externalIds?.tvdbId) || undefined;
  }
}
