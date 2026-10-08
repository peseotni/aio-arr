/* Jellyfin (and Emby, which speaks the same API): deep links, continue watching, history, library scans. */
import { BaseService, type TestResult } from './base.js';
import { httpRequest, type RequestOptions } from '../util/http.js';
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
  /** name fallback */
  name?: string;
  year?: number;
  type?: 'Movie' | 'Series' | 'MusicArtist' | 'MusicAlbum';
}

export interface ProviderIndex {
  byKey: Map<string, JellyfinRef>;
  byName: Map<string, JellyfinRef>;
  builtAt: number;
}

const INDEX_TTL = 5 * 60 * 1000;

const PREFIX: Record<string, string> = { Series: 'series', Movie: 'movie', MusicAlbum: 'album', MusicArtist: 'artist' };

export class JellyfinService extends BaseService {
  /** Emby serves its API below /emby */
  protected readonly apiPrefix: string = '';
  readonly product: string = 'Jellyfin';
  private index?: ProviderIndex;
  private indexPromise?: Promise<ProviderIndex>;
  private serverId?: string;
  private defaultUser?: string;

  override headers(): Record<string, string> {
    return { Authorization: `${CLIENT_HEADER}, Token="${this.cfg.apiKey}"` };
  }

  /** request() with the API prefix */
  protected call<T = any>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(`${this.apiPrefix}${path}`, opts);
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error(`${this.product}: an API key is required (Dashboard > API Keys)`);
    const info = await this.call<JRaw>('/System/Info', { timeoutMs: 10000 });
    return { ok: true, version: info.Version, message: `${this.product} ${info.Version} (${info.ServerName})` };
  }

  async getServerId(): Promise<string> {
    if (!this.serverId) {
      const info = await this.call<JRaw>('/System/Info/Public', { timeoutMs: 10000 });
      this.serverId = info.Id as string;
    }
    return this.serverId!;
  }

  /** Browser URL of an item (details page with the Play button). */
  itemUrl(itemId: string, serverId?: string): string {
    return `${this.publicUrl}/web/#/details?id=${encodeURIComponent(itemId)}${serverId ? `&serverId=${serverId}` : ''}`;
  }

  users(): Promise<JRaw[]> {
    return this.call('/Users');
  }

  /** The user whose home rows / history we use (configured, else first administrator). */
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
    return this.call('/UserItems/Resume', {
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
    return this.call('/Items/Latest', {
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
    return this.call('/Shows/NextUp', {
      query: { userId, limit, fields: 'PrimaryImageAspectRatio', enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1 },
    });
  }

  sessions(): Promise<JRaw[]> {
    return this.call('/Sessions', { query: { activeWithinSeconds: 900 } });
  }

  /** Items of a user, e.g. what they watched recently or marked as favourite. */
  userItems(userId: string, query: Record<string, string | number | boolean>): Promise<{ Items: JRaw[] }> {
    return this.call('/Items', { query: { userId, recursive: true, enableImages: false, ...query }, timeoutMs: 30000 });
  }

  /** Movies and shows the user watched most recently (episodes are folded into their show). */
  async watchHistory(userId: string, limit = 25): Promise<{ played: JRaw[]; favorites: JRaw[] }> {
    const fields = 'ProviderIds,ProductionYear';
    const [movies, episodes, favs] = await Promise.all([
      this.userItems(userId, { includeItemTypes: 'Movie', filters: 'IsPlayed', sortBy: 'DatePlayed', sortOrder: 'Descending', limit, fields }),
      this.userItems(userId, { includeItemTypes: 'Episode', filters: 'IsPlayed', sortBy: 'DatePlayed', sortOrder: 'Descending', limit: limit * 4, fields: 'SeriesId' }),
      this.userItems(userId, { includeItemTypes: 'Movie,Series', filters: 'IsFavorite', limit, fields }),
    ]);
    // order shows by the most recently watched episode
    const seriesOrder: string[] = [];
    const lastPlayed = new Map<string, string>();
    for (const e of episodes.Items || []) {
      if (!e.SeriesId || lastPlayed.has(e.SeriesId)) continue;
      seriesOrder.push(e.SeriesId);
      lastPlayed.set(e.SeriesId, e.UserData?.LastPlayedDate || '');
    }
    let series: JRaw[] = [];
    if (seriesOrder.length) {
      const res = await this.userItems(userId, { ids: seriesOrder.slice(0, limit).join(','), fields });
      const byId = new Map((res.Items || []).map((s) => [s.Id, s]));
      series = seriesOrder.map((id) => byId.get(id)).filter((s): s is JRaw => !!s);
    }
    const played = [...(movies.Items || []).map((m) => ({ ...m, _last: m.UserData?.LastPlayedDate || '' })), ...series.map((s) => ({ ...s, _last: lastPlayed.get(s.Id) || '' }))].sort(
      (a, b) => String(b._last).localeCompare(String(a._last)),
    );
    return { played, favorites: favs.Items || [] };
  }

  libraries(): Promise<JRaw[]> {
    return this.call('/Library/VirtualFolders');
  }

  counts(): Promise<JRaw> {
    return this.call('/Items/Counts');
  }

  refreshLibrary(): Promise<void> {
    return this.call('/Library/Refresh', { method: 'POST' });
  }

  /** Tell the server that files appeared somewhere (cheap, targeted scan). */
  notifyPaths(paths: string[]): Promise<void> {
    return this.call('/Library/Media/Updated', {
      method: 'POST',
      body: { Updates: paths.map((Path) => ({ Path, UpdateType: 'Created' })) },
    });
  }

  search(term: string, userId?: string): Promise<{ Items: JRaw[] }> {
    return this.call('/Items', {
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
    return this.call(`/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(type)}`, {
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
    const started = Date.now();
    const res = await this.call<{ Items: JRaw[] }>('/Items', {
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
      const artists = await this.call<{ Items: JRaw[] }>('/Artists/AlbumArtists', {
        query: { fields: 'ProviderIds', enableImages: false, enableUserData: false },
        timeoutMs: 60000,
      });
      const known = new Set(items.map((i) => i.Id));
      for (const a of artists?.Items || []) if (!known.has(a.Id)) items.push(a);
    } catch (err) {
      log.debug('album artists lookup failed', err);
    }
    const index = JellyfinService.buildIndexFrom(items);
    log.debug(`${this.product} provider index: ${items.length} items in ${Date.now() - started}ms`);
    return index;
  }

  /** Build the lookup maps from Items (exposed for tests). */
  static buildIndexFrom(items: JRaw[]): ProviderIndex {
    const byKey = new Map<string, JellyfinRef>();
    const byName = new Map<string, JellyfinRef>();
    for (const it of items) {
      const prefix = PREFIX[it.Type];
      if (!prefix) continue;
      const ref: JellyfinRef = { id: it.Id, type: it.Type, name: it.Name };
      const p = (it.ProviderIds || {}) as Record<string, string>;
      for (const [k, v] of Object.entries(p)) {
        if (!v) continue;
        byKey.set(`${prefix}:${k.toLowerCase()}:${String(v).toLowerCase()}`, ref);
      }
      byName.set(`${prefix}:${normName(it.Name)}`, ref);
      if (it.ProductionYear) byName.set(`${prefix}:${normName(it.Name)}:${it.ProductionYear}`, ref);
    }
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
  static lookup(index: ProviderIndex, q: ProviderQuery): JellyfinRef | undefined {
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
    if (!q.name) return undefined;
    // Music tags often lack ids: trust names. Films and shows need the year to match as well.
    if (prefix === 'artist' || prefix === 'album') return index.byName.get(`${prefix}:${normName(q.name)}`);
    if (q.year) return index.byName.get(`${prefix}:${normName(q.name)}:${q.year}`);
    return undefined;
  }

  async find(q: ProviderQuery): Promise<JellyfinRef | undefined> {
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
  static async createApiKey(url: string, username: string, password: string, product: 'Jellyfin' | 'Emby' = 'Jellyfin'): Promise<string> {
    const prefix = product === 'Emby' ? '/emby' : '';
    const loginHeaders: Record<string, string> = product === 'Emby' ? { 'X-Emby-Authorization': CLIENT_HEADER } : { Authorization: CLIENT_HEADER };
    const auth = await httpRequest<JRaw>({ name: product, baseUrl: url, headers: () => loginHeaders }, `${prefix}/Users/AuthenticateByName`, {
      method: 'POST',
      body: { Username: username, Pw: password },
      timeoutMs: 15000,
    });
    if (!auth?.User?.Policy?.IsAdministrator) throw new Error(`This ${product} user is not an administrator`);
    const token = auth.AccessToken as string;
    const authHeaders: Record<string, string> = product === 'Emby' ? { 'X-Emby-Token': token } : { Authorization: `${CLIENT_HEADER}, Token="${token}"` };
    const target = { name: product, baseUrl: url, headers: () => authHeaders };
    await httpRequest(target, `${prefix}/Auth/Keys`, { method: 'POST', query: product === 'Emby' ? { App: 'AIO Arr' } : { app: 'AIO Arr' } });
    const keys = await httpRequest<{ Items: JRaw[] }>(target, `${prefix}/Auth/Keys`);
    const mine = (keys.Items || [])
      .filter((k) => k.AppName === 'AIO Arr')
      .sort((a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated)))[0];
    if (!mine?.AccessToken) throw new Error(`${product} did not return the new API key`);
    return mine.AccessToken as string;
  }
}

/** Emby: same API as Jellyfin under /emby, its own token header and web app URLs. */
export class EmbyService extends JellyfinService {
  protected override readonly apiPrefix = '/emby';
  override readonly product = 'Emby';

  override headers(): Record<string, string> {
    return { 'X-Emby-Token': this.cfg.apiKey };
  }

  override itemUrl(itemId: string, serverId?: string): string {
    return `${this.publicUrl}/web/index.html#!/item?id=${encodeURIComponent(itemId)}${serverId ? `&serverId=${serverId}` : ''}`;
  }

  /** Emby keeps user data below /Users/{id}/Items */
  override userItems(userId: string, query: Record<string, string | number | boolean>): Promise<{ Items: JRaw[] }> {
    return this.call(`/Users/${encodeURIComponent(userId)}/Items`, { query: { recursive: true, enableImages: false, ...query }, timeoutMs: 30000 });
  }
}

export function normName(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}
