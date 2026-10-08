/* Reading apps: Komga and Kavita (comics, manga, ebooks). */
import path from 'node:path';
import { BaseService, type TestResult } from './base.js';
import { ServiceError, httpRequest, type RequestOptions } from '../util/http.js';
import { normName } from './jellyfin.js';

type Raw = Record<string, any>;

function bestMatch<T>(list: T[], title: string, name: (x: T) => string): T | undefined {
  const want = normName(title);
  return list.find((x) => normName(name(x)) === want) || list.find((x) => normName(name(x)).startsWith(want) || want.startsWith(normName(name(x)))) || list[0];
}

/** Library whose root folder contains the path (else one whose root folder name matches). */
function libraryFor<T>(libs: T[], dest: string, roots: (l: T) => string[]): T | undefined {
  const d = dest.replace(/\/+$/, '');
  return (
    libs.find((l) => roots(l).some((r) => d === r.replace(/\/+$/, '') || d.startsWith(`${r.replace(/\/+$/, '')}/`))) ||
    libs.find((l) => roots(l).some((r) => d.split('/').includes(path.basename(r))))
  );
}

/* ------------------------------------------------------------------ */

export class KomgaService extends BaseService {
  override headers(): Record<string, string> {
    if (this.cfg.apiKey) return { 'X-API-Key': this.cfg.apiKey };
    if (this.cfg.username) return { Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}` };
    return {};
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey && !this.cfg.username) throw new Error('Komga: an API key (or email + password) is required');
    const me = await this.request<Raw>('/api/v2/users/me', { timeoutMs: 10000 });
    const info = await this.request<Raw>('/actuator/info', { timeoutMs: 10000 }).catch(() => undefined);
    const version = info?.build?.version as string | undefined;
    const libs = await this.libraries();
    return { ok: true, version, message: `Komga ${version || ''} - ${libs.length} libraries (${me?.email || 'signed in'})`.replace(/\s+/g, ' ') };
  }

  libraries(): Promise<Raw[]> {
    return this.request('/api/v1/libraries');
  }

  scan(libraryId: string): Promise<void> {
    return this.request(`/api/v1/libraries/${encodeURIComponent(libraryId)}/scan`, { method: 'POST' });
  }

  /** Scan the library that holds a folder (all libraries if none matches). */
  async scanForPath(dest: string): Promise<void> {
    const libs = await this.libraries();
    const lib = libraryFor(libs, dest, (l) => [String(l.root || '')]);
    for (const l of lib ? [lib] : libs) await this.scan(l.id);
  }

  async findSeries(title: string): Promise<Raw | undefined> {
    const r = await this.request<Raw>('/api/v1/series', { query: { search: title, size: 10 } });
    return bestMatch<Raw>(r?.content || [], title, (s) => s.metadata?.title || s.name);
  }

  async findBook(title: string): Promise<Raw | undefined> {
    const r = await this.request<Raw>('/api/v1/books', { query: { search: title, size: 10 } });
    return bestMatch<Raw>(r?.content || [], title, (b) => b.metadata?.title || b.name);
  }

  seriesUrl(id: string): string {
    return `${this.publicUrl}/series/${id}`;
  }

  bookUrl(id: string): string {
    return `${this.publicUrl}/book/${id}`;
  }
}

/* ------------------------------------------------------------------ */

export class KavitaService extends BaseService {
  private token?: { value: string; exp: number };
  private tokenPromise?: Promise<string>;

  /** Kavita hands out a short-lived JWT for an API key. */
  private async getToken(): Promise<string> {
    if (this.token && this.token.exp - Date.now() > 5 * 60 * 1000) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = httpRequest<Raw>({ name: this.name, baseUrl: this.baseUrl }, '/api/Plugin/authenticate', {
        method: 'POST',
        query: { apiKey: this.cfg.apiKey, pluginName: 'AIO Arr' },
        timeoutMs: 15000,
      })
        .then((r) => {
          const value = String(r?.token || '');
          if (!value) throw new Error('Kavita: no token returned - check the API key');
          let exp = Date.now() + 60 * 60 * 1000;
          try {
            const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
            if (payload.exp) exp = payload.exp * 1000;
          } catch {
            /* keep the default */
          }
          this.token = { value, exp };
          return value;
        })
        .finally(() => {
          this.tokenPromise = undefined;
        });
    }
    return this.tokenPromise;
  }

  override async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  override async request<T = any>(p: string, opts?: RequestOptions): Promise<T> {
    try {
      return await super.request<T>(p, opts);
    } catch (err) {
      // token revoked or expired early: get a new one once
      if (err instanceof ServiceError && err.upstreamStatus === 401 && this.token) {
        this.token = undefined;
        return super.request<T>(p, opts);
      }
      throw err;
    }
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('Kavita: an API key is required (your user settings > API key / 3rd party clients)');
    const info = await this.request<Raw>('/api/Server/server-info-slim', { timeoutMs: 10000 });
    const libs = await this.libraries();
    return { ok: true, version: info?.kavitaVersion, message: `Kavita ${info?.kavitaVersion || ''} - ${libs.length} libraries`.replace(/\s+/g, ' ') };
  }

  libraries(): Promise<Raw[]> {
    return this.request('/api/Library/libraries');
  }

  /** Kavita's own "scan this folder" endpoint (meant for tools like this one). */
  scanFolder(folderPath: string): Promise<void> {
    return this.request('/api/Library/scan-folder', { method: 'POST', body: { apiKey: this.cfg.apiKey, folderPath } });
  }

  private scanLibrary(id: number): Promise<void> {
    return this.request('/api/Library/scan', { method: 'POST', query: { libraryId: id, force: false } });
  }

  async scanForPath(dest: string): Promise<void> {
    const libs = await this.libraries();
    const folders = (l: Raw) => ((l.folders || []) as unknown[]).map((f) => String(typeof f === 'object' && f ? (f as Raw).path : f).replace(/\/+$/, ''));
    const d = dest.replace(/\/+$/, '');
    const owner = libs.find((l) => folders(l).some((r) => d === r || d.startsWith(`${r}/`)));
    if (owner) {
      // Kavita sees the same path: scan just that folder
      try {
        await this.scanFolder(d);
        return;
      } catch {
        return this.scanLibrary(owner.id);
      }
    }
    // different mount points: scan the library whose folder has the same name (or all of them)
    const lib = libraryFor(libs, dest, folders);
    for (const l of lib ? [lib] : libs) await this.scanLibrary(l.id);
  }

  async findSeries(title: string): Promise<Raw | undefined> {
    const r = await this.request<Raw>('/api/Search/search', { query: { queryString: title } });
    return bestMatch<Raw>(r?.series || [], title, (s) => s.name || s.originalName);
  }

  seriesUrl(libraryId: number, seriesId: number): string {
    return `${this.publicUrl}/library/${libraryId}/series/${seriesId}`;
  }
}
