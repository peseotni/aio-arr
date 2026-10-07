/* Listening apps: Navidrome (music, Subsonic API) and Audiobookshelf (audiobooks & podcasts). Plus Bazarr (subtitles). */
import crypto from 'node:crypto';
import path from 'node:path';
import { BaseService, type TestResult } from './base.js';
import type { RequestOptions } from '../util/http.js';

type Raw = Record<string, any>;

export class NavidromeService extends BaseService {
  private subsonic<T = Raw>(endpoint: string, query: Record<string, string | number> = {}, opts: RequestOptions = {}): Promise<T> {
    const salt = crypto.randomBytes(6).toString('hex');
    const token = crypto.createHash('md5').update(this.cfg.password + salt).digest('hex');
    return this.request<{ 'subsonic-response': Raw }>(`/rest/${endpoint}`, {
      ...opts,
      query: { u: this.cfg.username, t: token, s: salt, v: '1.16.1', c: 'aio-arr', f: 'json', ...query },
    }).then((res) => {
      const r = res?.['subsonic-response'];
      if (!r) throw new Error('Navidrome: unexpected response');
      if (r.status !== 'ok') throw new Error(`Navidrome: ${r.error?.message || 'request failed'}`);
      return r as T;
    });
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.username || !this.cfg.password) throw new Error('Navidrome: username and password are required');
    const r = await this.subsonic<Raw>('ping');
    return { ok: true, version: r.serverVersion, message: `Navidrome ${r.serverVersion || ''}`.trim() };
  }

  startScan(): Promise<Raw> {
    return this.subsonic('startScan');
  }

  scanStatus(): Promise<Raw> {
    return this.subsonic('getScanStatus');
  }

  async findAlbum(album: string, artist?: string): Promise<string | undefined> {
    const r = await this.subsonic<Raw>('search3', { query: album, albumCount: 10, artistCount: 0, songCount: 0 });
    const albums: Raw[] = r.searchResult3?.album || [];
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit =
      albums.find((a) => norm(a.name) === norm(album) && (!artist || norm(a.artist) === norm(artist))) ||
      albums.find((a) => norm(a.name) === norm(album)) ||
      albums[0];
    return hit?.id;
  }

  async findArtist(name: string): Promise<string | undefined> {
    const r = await this.subsonic<Raw>('search3', { query: name, albumCount: 0, artistCount: 5, songCount: 0 });
    const artists: Raw[] = r.searchResult3?.artist || [];
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return (artists.find((a) => norm(a.name) === norm(name)) || artists[0])?.id;
  }

  albumUrl(id: string): string {
    return `${this.publicUrl}/app/#/album/${id}/show`;
  }

  artistUrl(id: string): string {
    return `${this.publicUrl}/app/#/artist/${id}/show`;
  }
}

export class AudiobookshelfService extends BaseService {
  override headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('Audiobookshelf: an API token is required (Settings > API Keys, or your user token)');
    const [status, libs] = await Promise.all([this.request<Raw>('/status', { timeoutMs: 10000 }), this.libraries()]);
    return { ok: true, version: status?.serverVersion, message: `Audiobookshelf ${status?.serverVersion || ''} - ${libs.length} libraries`.trim() };
  }

  async libraries(): Promise<Raw[]> {
    const r = await this.request<Raw>('/api/libraries');
    return r?.libraries || [];
  }

  scan(libraryId: string): Promise<void> {
    return this.request(`/api/libraries/${libraryId}/scan`, { method: 'POST' });
  }

  /** Scan every library that contains the given (container) path, using folder names to match. */
  async scanForPath(destPath: string): Promise<string | undefined> {
    const libs = await this.libraries();
    const dest = destPath.replace(/\/+$/, '');
    // The folder paths are as seen by ABS; match on the trailing folder name as a fallback.
    const lib =
      libs.find((l) => (l.folders || []).some((f: Raw) => dest.startsWith(String(f.fullPath).replace(/\/+$/, '') + '/'))) ||
      libs.find((l) => (l.folders || []).some((f: Raw) => path.basename(String(f.fullPath)) === path.basename(path.dirname(dest)))) ||
      libs.find((l) => l.mediaType === 'book');
    if (!lib) return undefined;
    await this.scan(lib.id);
    return lib.id as string;
  }

  async findItem(title: string): Promise<string | undefined> {
    const libs = await this.libraries();
    for (const lib of libs) {
      const r = await this.request<Raw>(`/api/libraries/${lib.id}/search`, { query: { q: title, limit: 5 } });
      const items: Raw[] = [...(r?.book || []), ...(r?.podcast || [])];
      if (items[0]?.libraryItem?.id) return items[0].libraryItem.id as string;
    }
    return undefined;
  }

  itemUrl(id: string): string {
    return `${this.publicUrl}/item/${id}`;
  }
}

export class BazarrService extends BaseService {
  override headers(): Record<string, string> {
    return { 'X-API-KEY': this.cfg.apiKey };
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('Bazarr: an API key is required (Settings > General)');
    const r = await this.request<Raw>('/api/system/status', { timeoutMs: 10000 });
    const v = r?.data?.bazarr_version;
    return { ok: true, version: v, message: `Bazarr ${v || ''}`.trim() };
  }

  async status(): Promise<{ version?: string }> {
    const r = await this.request<Raw>('/api/system/status', { timeoutMs: 10000 });
    return { version: r?.data?.bazarr_version };
  }

  /** Counts of missing subtitles etc. */
  badges(): Promise<Raw> {
    return this.request('/api/badges', { timeoutMs: 10000 });
  }

  async health(): Promise<{ object: string; issue: string }[]> {
    const r = await this.request<Raw>('/api/system/health', { timeoutMs: 10000 });
    return Array.isArray(r?.data) ? r.data : [];
  }

  searchMovie(radarrId: number): Promise<void> {
    return this.request('/api/movies', { method: 'PATCH', query: { radarrid: radarrId, action: 'search-missing' } });
  }

  searchSeries(seriesId: number): Promise<void> {
    return this.request('/api/series', { method: 'PATCH', query: { seriesid: seriesId, action: 'search-missing' } });
  }
}
