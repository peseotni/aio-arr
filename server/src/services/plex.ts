/* Plex Media Server: "Watch in Plex" links (matched by TMDB / IMDb / TVDB ids), library scans. */
import { BaseService, type TestResult } from './base.js';
import { moduleLogger } from '../log.js';
import { normName } from './jellyfin.js';

const log = moduleLogger('plex');

type Raw = Record<string, any>;

export interface PlexRef {
  ratingKey: string;
  type: string;
  title: string;
}

export interface PlexIndex {
  byKey: Map<string, PlexRef>;
  byName: Map<string, PlexRef>;
  builtAt: number;
}

export interface PlexQuery {
  type: 'movie' | 'show' | 'album' | 'artist';
  tmdb?: number | string;
  tvdb?: number | string;
  imdb?: string;
  mb?: string;
  name?: string;
  year?: number;
  artist?: string;
}

const INDEX_TTL = 5 * 60 * 1000;

export class PlexService extends BaseService {
  private index?: PlexIndex;
  private indexPromise?: Promise<PlexIndex>;
  private machineId?: string;

  override headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'X-Plex-Product': 'AIO Arr',
      'X-Plex-Client-Identifier': 'aio-arr-server',
    };
    if (this.cfg.apiKey) h['X-Plex-Token'] = this.cfg.apiKey;
    return h;
  }

  private container<T = Raw>(path: string, query?: Record<string, string | number>): Promise<T> {
    return this.request<{ MediaContainer: T }>(path, { query, timeoutMs: 60000 }).then((r) => (r?.MediaContainer || {}) as T);
  }

  async test(): Promise<TestResult> {
    const mc = await this.container<Raw>('/');
    if (!mc.machineIdentifier) throw new Error('Plex: unexpected answer - is this the Plex Media Server address (port 32400)?');
    // the root answers without a token on "allowed networks", so check something that needs one
    await this.container('/library/sections');
    this.machineId = mc.machineIdentifier;
    return { ok: true, version: mc.version, message: `Plex ${String(mc.version || '').split('-')[0]} (${mc.friendlyName || 'server'})` };
  }

  async getMachineId(): Promise<string> {
    if (!this.machineId) {
      const mc = await this.container<Raw>('/identity');
      this.machineId = mc.machineIdentifier as string;
    }
    return this.machineId!;
  }

  /** The web app: your own server address if set, otherwise app.plex.tv (the internal address rarely works in a browser). */
  override get publicUrl(): string {
    const u = (this.cfg.publicUrl || '').replace(/\/+$/, '');
    if (!u) return 'https://app.plex.tv/desktop';
    // app.plex.tv/desktop and ".../web/index.html" are already the web app
    if (/app\.plex\.tv/i.test(u) || /\/web\/index\.html$/i.test(u)) return u;
    return `${u.replace(/\/web$/i, '')}/web/index.html`;
  }

  itemUrl(ratingKey: string, machineId: string): string {
    return `${this.publicUrl}#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
  }

  async sections(): Promise<Raw[]> {
    const mc = await this.container<Raw>('/library/sections');
    return mc.Directory || [];
  }

  /** Scan only the folder that changed (falls back to the whole section). */
  async scanPath(folder: string): Promise<void> {
    const dir = folder.replace(/\/+$/, '');
    const sections = await this.sections();
    const hits = sections.filter((s) => (s.Location || []).some((l: Raw) => dir === l.path || dir.startsWith(`${String(l.path).replace(/\/+$/, '')}/`)));
    for (const s of hits) await this.request(`/library/sections/${s.key}/refresh`, { query: { path: dir } });
    if (!hits.length) log.debug(`no Plex library contains ${dir}`);
  }

  async refreshAll(): Promise<void> {
    await this.request('/library/sections/all/refresh');
  }

  /* ---------------- index ---------------- */

  invalidateIndex(): void {
    this.index = undefined;
  }

  private async buildIndex(): Promise<PlexIndex> {
    const started = Date.now();
    const items: Raw[] = [];
    for (const s of await this.sections()) {
      try {
        if (s.type === 'movie' || s.type === 'show') {
          const mc = await this.container<Raw>(`/library/sections/${s.key}/all`, { includeGuids: 1 });
          items.push(...(mc.Metadata || []));
        } else if (s.type === 'artist') {
          const [artists, albums] = await Promise.all([
            this.container<Raw>(`/library/sections/${s.key}/all`, { type: 8, includeGuids: 1 }),
            this.container<Raw>(`/library/sections/${s.key}/all`, { type: 9, includeGuids: 1 }),
          ]);
          items.push(...(artists.Metadata || []), ...(albums.Metadata || []));
        }
      } catch (err) {
        log.debug(`section ${s.title} could not be read`, (err as Error).message);
      }
    }
    const idx = PlexService.buildIndexFrom(items);
    log.debug(`Plex index: ${items.length} items in ${Date.now() - started}ms`);
    return idx;
  }

  /** Exposed for tests: Metadata[] (with Guid arrays) -> lookup maps. */
  static buildIndexFrom(items: Raw[]): PlexIndex {
    const byKey = new Map<string, PlexRef>();
    const byName = new Map<string, PlexRef>();
    for (const m of items) {
      const type = m.type as string;
      if (!['movie', 'show', 'album', 'artist'].includes(type)) continue;
      const ref: PlexRef = { ratingKey: String(m.ratingKey), type, title: m.title };
      for (const g of m.Guid || []) {
        // "imdb://tt0133093", "tmdb://603", "tvdb://81189", "mbid://..."
        const mm = /^([a-z]+):\/\/(.+)$/.exec(String(g.id || ''));
        if (mm) byKey.set(`${type}:${mm[1]}:${mm[2].toLowerCase()}`, ref);
      }
      const name = normName(m.title);
      byName.set(`${type}:${name}`, ref);
      if (m.year) byName.set(`${type}:${name}:${m.year}`, ref);
      if (type === 'album' && m.parentTitle) byName.set(`album:${normName(m.parentTitle)}:${name}`, ref);
    }
    return { byKey, byName, builtAt: Date.now() };
  }

  async getIndex(force = false): Promise<PlexIndex> {
    if (!force && this.index && Date.now() - this.index.builtAt < INDEX_TTL) return this.index;
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex()
        .then((idx) => (this.index = idx))
        .finally(() => {
          this.indexPromise = undefined;
        });
    }
    if (this.index && !force) return this.index;
    return this.indexPromise;
  }

  static lookup(index: PlexIndex, q: PlexQuery): PlexRef | undefined {
    const tries: string[] = [];
    if (q.tmdb) tries.push(`${q.type}:tmdb:${q.tmdb}`);
    if (q.tvdb) tries.push(`${q.type}:tvdb:${q.tvdb}`);
    if (q.imdb) tries.push(`${q.type}:imdb:${String(q.imdb).toLowerCase()}`);
    if (q.mb) tries.push(`${q.type}:mbid:${q.mb.toLowerCase()}`);
    for (const k of tries) {
      const hit = index.byKey.get(k);
      if (hit) return hit;
    }
    if (!q.name) return undefined;
    const name = normName(q.name);
    if (q.type === 'album') return (q.artist && index.byName.get(`album:${normName(q.artist)}:${name}`)) || index.byName.get(`album:${name}`);
    if (q.type === 'artist') return index.byName.get(`artist:${name}`);
    // films and shows: the year has to match too
    return q.year ? index.byName.get(`${q.type}:${name}:${q.year}`) : undefined;
  }
}
