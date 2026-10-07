/* Jellyfin: deep links ("watch now"), continue watching, recently added, sessions, library scans. */
import { BaseService, type TestResult } from './base.js';
import { httpRequest } from '../util/http.js';
import { moduleLogger } from '../log.js';

const log = moduleLogger('jellyfin');

export type JRaw = Record<string, any>;

const CLIENT_HEADER = 'MediaBrowser Client="AIO Arr", Device="AIO Arr Server", DeviceId="aio-arr-server", Version="1.0.0"';

export interface JellyfinRef {
  id: string;
  type: string;
  name: string;
}

export interface ProviderQuery {
  tmdb?: number | string;
  tvdb?: number | string;
  imdb?: string;
  /** MusicBrainz release group (Lidarr foreignAlbumId) */
  mbReleaseGroup?: string;
  /** MusicBrainz artist (Lidarr foreignArtistId) */
  mbArtist?: string;
  /** name fallback (artists/albums) */
  name?: string;
  type?: 'Movie' | 'Series' | 'MusicArtist' | 'MusicAlbum';
}

interface ProviderIndex {
  byKey: Map<string, JellyfinRef>;
  byName: Map<string, JellyfinRef>;
  builtAt: number;
}

const INDEX_TTL = 5 * 60 * 1000;

export class JellyfinService extends BaseService {
  private index?: ProviderIndex;
  private indexPromise?: Promise<ProviderIndex>;
  private serverId?: string;
  private defaultUser?: string;

  override headers(): Record<string, string> {
    return { Authorization: `${CLIENT_HEADER}, Token="${this.cfg.apiKey}"` };
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('Jellyfin: an API key is required (Dashboard > API Keys)');
    const info = await this.request<JRaw>('/System/Info', { timeoutMs: 10000 });
    return { ok: true, version: info.Version, message: `Jellyfin ${info.Version} (${info.ServerName})` };
  }

  async getServerId(): Promise<string> {
    if (!this.serverId) {
      const info = await this.request<JRaw>('/System/Info/Public', { timeoutMs: 10000 });
      this.serverId = info.Id as string;
    }
    return this.serverId!;
  }

  /** Browser URL of an item (details page with the Play button). */
  itemUrl(itemId: string, serverId?: string): string {
    return `${this.publicUrl}/web/#/details?id=${encodeURIComponent(itemId)}${serverId ? `&serverId=${serverId}` : ''}`;
  }

  users(): Promise<JRaw[]> {
    return this.request('/Users');
  }

  /** The user whose home rows we show (configured, else first administrator). */
  async homeUserId(preferred?: string): Promise<string | undefined> {
    if (preferred) return preferred;
    if (this.cfg.userId) return this.cfg.userId;
    if (this.defaultUser) return this.defaultUser;
    const users = await this.users();
    const admin = users.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) || users[0];
    this.defaultUser = admin?.Id;
    return this.defaultUser;
  }

  resume(userId: string, limit = 12): Promise<{ Items: JRaw[] }> {
    return this.request('/UserItems/Resume', {
      query: {
        userId,
        limit,
        mediaTypes: 'Video',
        fields: 'PrimaryImageAspectRatio,ProviderIds,Overview',
        enableImageTypes: 'Primary,Backdrop,Thumb',
        imageTypeLimit: 1,
      },
    });
  }

  latest(userId: string, limit = 16): Promise<JRaw[]> {
    return this.request('/Items/Latest', {
      query: {
        userId,
        limit,
        fields: 'PrimaryImageAspectRatio,ProviderIds,DateCreated',
        enableImageTypes: 'Primary,Backdrop,Thumb',
        imageTypeLimit: 1,
        groupItems: true,
      },
    });
  }

  nextUp(userId: string, limit = 12): Promise<{ Items: JRaw[] }> {
    return this.request('/Shows/NextUp', {
      query: { userId, limit, fields: 'PrimaryImageAspectRatio', enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1 },
    });
  }

  sessions(): Promise<JRaw[]> {
    return this.request('/Sessions', { query: { activeWithinSeconds: 900 } });
  }

  libraries(): Promise<JRaw[]> {
    return this.request('/Library/VirtualFolders');
  }

  counts(): Promise<JRaw> {
    return this.request('/Items/Counts');
  }

  refreshLibrary(): Promise<void> {
    return this.request('/Library/Refresh', { method: 'POST' });
  }

  /** Tell Jellyfin that files appeared somewhere (cheap, targeted scan). */
  notifyPaths(paths: string[]): Promise<void> {
    return this.request('/Library/Media/Updated', {
      method: 'POST',
      body: { Updates: paths.map((Path) => ({ Path, UpdateType: 'Created' })) },
    });
  }

  search(term: string, userId?: string): Promise<{ Items: JRaw[] }> {
    return this.request('/Items', {
      query: {
        userId,
        searchTerm: term,
        recursive: true,
        limit: 24,
        includeItemTypes: 'Movie,Series,MusicAlbum,MusicArtist,Audio,AudioBook,Book',
        fields: 'ProviderIds,PrimaryImageAspectRatio',
      },
    });
  }

  image(itemId: string, type: string, query: Record<string, string | number | undefined>): Promise<Response> {
    return this.request(`/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(type)}`, {
      query,
      responseType: 'raw',
      timeoutMs: 20000,
    });
  }

  /* ---------------- provider-id index (tmdb/tvdb/imdb/musicbrainz -> item) ---------------- */

  invalidateIndex(): void {
    this.index = undefined;
  }

  private async buildIndex(): Promise<ProviderIndex> {
    const byKey = new Map<string, JellyfinRef>();
    const byName = new Map<string, JellyfinRef>();
    const started = Date.now();
    const res = await this.request<{ Items: JRaw[] }>('/Items', {
      query: {
        recursive: true,
        includeItemTypes: 'Movie,Series,MusicAlbum,MusicArtist',
        fields: 'ProviderIds,ProductionYear',
        enableImages: false,
        enableUserData: false,
        enableTotalRecordCount: false,
      },
      timeoutMs: 60000,
    });
    const items = res?.Items || [];
    // Album artists are not always returned by /Items, fetch them explicitly.
    try {
      const artists = await this.request<{ Items: JRaw[] }>('/Artists/AlbumArtists', {
        query: { fields: 'ProviderIds', enableImages: false, enableUserData: false },
        timeoutMs: 60000,
      });
      for (const a of artists?.Items || []) if (!items.some((i) => i.Id === a.Id)) items.push(a);
    } catch (err) {
      log.debug('album artists lookup failed', err);
    }
    for (const it of items) {
      const ref: JellyfinRef = { id: it.Id, type: it.Type, name: it.Name };
      const p = (it.ProviderIds || {}) as Record<string, string>;
      const prefix = it.Type === 'Series' ? 'series' : it.Type === 'Movie' ? 'movie' : it.Type === 'MusicAlbum' ? 'album' : 'artist';
      for (const [k, v] of Object.entries(p)) {
        if (!v) continue;
        byKey.set(`${prefix}:${k.toLowerCase()}:${String(v).toLowerCase()}`, ref);
      }
      byName.set(`${prefix}:${normName(it.Name)}`, ref);
      if (it.ProductionYear) byName.set(`${prefix}:${normName(it.Name)}:${it.ProductionYear}`, ref);
    }
    log.debug(`provider index: ${items.length} items in ${Date.now() - started}ms`);
    return { byKey, byName, builtAt: Date.now() };
  }

  async getIndex(force = false): Promise<ProviderIndex> {
    if (!force && this.index && Date.now() - this.index.builtAt < INDEX_TTL) return this.index;
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex()
        .then((idx) => {
          this.index = idx;
          return idx;
        })
        .finally(() => {
          this.indexPromise = undefined;
        });
    }
    // Serve a stale index while rebuilding, if we have one
    if (this.index && !force) return this.index;
    return this.indexPromise;
  }

  /** Synchronous lookup against an already built index. */
  static lookup(index: ProviderIndex, q: ProviderQuery & { year?: number }): JellyfinRef | undefined {
    const prefix = q.type === 'Series' ? 'series' : q.type === 'Movie' ? 'movie' : q.type === 'MusicAlbum' ? 'album' : 'artist';
    const tries: string[] = [];
    if (q.tmdb) tries.push(`${prefix}:tmdb:${q.tmdb}`);
    if (q.tvdb) tries.push(`${prefix}:tvdb:${q.tvdb}`);
    if (q.imdb) tries.push(`${prefix}:imdb:${String(q.imdb).toLowerCase()}`);
    if (q.mbReleaseGroup) tries.push(`${prefix}:musicbrainzreleasegroup:${q.mbReleaseGroup.toLowerCase()}`);
    if (q.mbArtist) {
      tries.push(`${prefix}:musicbrainzartist:${q.mbArtist.toLowerCase()}`);
      tries.push(`${prefix}:musicbrainzalbumartist:${q.mbArtist.toLowerCase()}`);
    }
    for (const k of tries) {
      const hit = index.byKey.get(k);
      if (hit) return hit;
    }
    // Names are only trusted for music (ids are often missing from tags)
    if (q.name && (prefix === 'artist' || prefix === 'album')) {
      return index.byName.get(`${prefix}:${normName(q.name)}`);
    }
    return undefined;
  }

  async find(q: ProviderQuery & { year?: number }): Promise<JellyfinRef | undefined> {
    const idx = await this.getIndex();
    let hit = JellyfinService.lookup(idx, q);
    if (!hit && Date.now() - idx.builtAt > 30000) {
      // The item may have been imported a moment ago
      hit = JellyfinService.lookup(await this.getIndex(true), q);
    }
    return hit;
  }

  /* ---------------- authentication helpers ---------------- */

  static async authenticate(url: string, username: string, password: string): Promise<JRaw> {
    return httpRequest<JRaw>({ name: 'Jellyfin', baseUrl: url, headers: () => ({ Authorization: CLIENT_HEADER }) }, '/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: username, Pw: password },
      timeoutMs: 15000,
    });
  }

  /** Log in as an admin and create an API key for AIO Arr. */
  static async createApiKey(url: string, username: string, password: string): Promise<string> {
    const auth = await JellyfinService.authenticate(url, username, password);
    if (!auth?.User?.Policy?.IsAdministrator) throw new Error('This Jellyfin user is not an administrator');
    const token = auth.AccessToken as string;
    const target = { name: 'Jellyfin', baseUrl: url, headers: () => ({ Authorization: `${CLIENT_HEADER}, Token="${token}"` }) };
    await httpRequest(target, '/Auth/Keys', { method: 'POST', query: { app: 'AIO Arr' } });
    const keys = await httpRequest<{ Items: JRaw[] }>(target, '/Auth/Keys');
    const mine = (keys.Items || [])
      .filter((k) => k.AppName === 'AIO Arr')
      .sort((a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated)))[0];
    if (!mine?.AccessToken) throw new Error('Jellyfin did not return the new API key');
    return mine.AccessToken as string;
  }
}

export function normName(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}
