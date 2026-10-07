import dns from 'node:dns/promises';
import net from 'node:net';
import type { ServiceConfig } from '../../config.js';
import { BaseService, type TestResult } from '../base.js';
import { ServiceError, type RequestOptions } from '../../util/http.js';
import {
  clampProgress,
  isoFromUnix,
  parseHms,
  type AddRequest,
  type AddResult,
  type ClientStats,
  type DownloadClient,
  type DownloadItem,
  type DownloadState,
} from './types.js';

type Raw = Record<string, any>;

const QUEUE_STATE: Record<string, DownloadState> = {
  Downloading: 'downloading',
  Queued: 'queued',
  Paused: 'paused',
  Fetching: 'metadata',
  Grabbing: 'metadata',
  Propagating: 'queued',
  Checking: 'checking',
};

const HISTORY_STATE: Record<string, DownloadState> = {
  Completed: 'completed',
  Failed: 'failed',
  Queued: 'processing',
  QuickCheck: 'processing',
  Verifying: 'processing',
  Repairing: 'processing',
  Extracting: 'processing',
  Moving: 'processing',
  Running: 'processing',
  Fetching: 'processing',
  Deleted: 'failed',
};

export class SabnzbdClient extends BaseService implements DownloadClient {
  readonly protocol = 'usenet' as const;
  readonly supportsAltSpeed = false;
  declare readonly id: 'sabnzbd';
  /** Base URL using the container IP, used when SABnzbd's hostname verification blocks us. */
  private ipBase?: string;

  constructor(cfg: ServiceConfig) {
    super('sabnzbd', 'SABnzbd', cfg);
  }

  override get baseUrl(): string {
    return this.ipBase || this.cfg.url;
  }

  private async api<T = Raw>(params: Record<string, string | number>, opts: RequestOptions = {}): Promise<T> {
    const exec = () =>
      this.request<T>('/api', {
        ...opts,
        query: { output: 'json', apikey: this.cfg.apiKey, ...params, ...(opts.query as Record<string, string>) },
      });
    try {
      const r = await exec();
      return this.checkResult(r);
    } catch (err) {
      if (err instanceof ServiceError && err.upstreamStatus === 403 && /hostname verification/i.test(String(err.details)) && !this.ipBase) {
        // SABnzbd only accepts whitelisted hostnames; talking to the IP address is always allowed.
        const u = new URL(this.cfg.url);
        if (!net.isIP(u.hostname)) {
          const { address } = await dns.lookup(u.hostname);
          u.hostname = address.includes(':') ? `[${address}]` : address;
          this.ipBase = u.toString().replace(/\/+$/, '');
          return this.checkResult(await exec());
        }
      }
      throw err;
    }
  }

  private checkResult<T>(r: T): T {
    const obj = r as unknown as Raw;
    if (obj && typeof obj === 'object' && obj.status === false && obj.error) {
      throw new ServiceError(`SABnzbd: ${obj.error}`, this.name);
    }
    if (typeof r === 'string' && /api key/i.test(r)) throw new ServiceError(`SABnzbd: ${r}`, this.name, 401);
    return r;
  }

  async test(): Promise<TestResult> {
    if (!this.cfg.apiKey) throw new Error('SABnzbd: an API key is required (Config > General)');
    const v = await this.api<Raw>({ mode: 'version' });
    // version does not need the key - make sure the key is valid too
    await this.api({ mode: 'queue', limit: 1 });
    return { ok: true, version: v.version, message: `SABnzbd ${v.version}` };
  }

  async list(): Promise<DownloadItem[]> {
    const [q, h] = await Promise.all([this.api<Raw>({ mode: 'queue', limit: 200 }), this.api<Raw>({ mode: 'history', limit: 60 })]);
    const queue: DownloadItem[] = (q.queue?.slots || []).map((s: Raw) => {
      const totalMb = parseFloat(s.mb) || 0;
      const leftMb = parseFloat(s.mbleft) || 0;
      const size = Math.round(totalMb * 1048576);
      const state = QUEUE_STATE[s.status as string] ?? 'queued';
      const globalSpeed = parseFloat(q.queue?.kbpersec) * 1024 || 0;
      return {
        client: 'sabnzbd',
        clientName: this.name,
        protocol: 'usenet',
        id: s.nzo_id,
        name: s.filename,
        category: s.cat && s.cat !== '*' ? s.cat : '',
        state,
        rawState: s.status,
        progress: clampProgress((parseFloat(s.percentage) || 0) / 100),
        size,
        downloaded: Math.round((totalMb - leftMb) * 1048576),
        // SAB only reports a global speed: attribute it to the active item
        downloadSpeed: state === 'downloading' ? globalSpeed : 0,
        uploadSpeed: 0,
        eta: state === 'downloading' ? parseHms(s.timeleft) : null,
        done: false,
        paused: s.status === 'Paused',
      } satisfies DownloadItem;
    });
    // only the first downloading slot actually transfers
    let seen = false;
    for (const it of queue) {
      if (it.state === 'downloading') {
        if (seen) it.downloadSpeed = 0;
        seen = true;
      }
    }
    const history: DownloadItem[] = (h.history?.slots || []).map((s: Raw) => {
      const state = HISTORY_STATE[s.status as string] ?? 'processing';
      return {
        client: 'sabnzbd',
        clientName: this.name,
        protocol: 'usenet',
        id: s.nzo_id,
        name: s.name,
        category: s.category && s.category !== '*' ? s.category : '',
        state,
        rawState: s.status,
        progress: state === 'failed' ? 0 : 1,
        size: s.bytes || 0,
        downloaded: s.bytes || 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        eta: null,
        completedAt: isoFromUnix(s.completed),
        contentPath: s.storage || undefined,
        message: s.fail_message || (state === 'processing' ? s.action_line : undefined) || undefined,
        done: state === 'completed',
        paused: false,
        inHistory: true,
      } satisfies DownloadItem;
    });
    return [...queue, ...history];
  }

  async stats(): Promise<ClientStats> {
    const q = await this.api<Raw>({ mode: 'queue', limit: 1 });
    return {
      downloadSpeed: (parseFloat(q.queue?.kbpersec) || 0) * 1024,
      uploadSpeed: 0,
      paused: !!q.queue?.paused,
      version: q.queue?.version,
    };
  }

  async add(req: AddRequest): Promise<AddResult> {
    const cat = req.category || '';
    if (cat) await this.ensureCategory(cat);
    let r: Raw;
    if (req.file) {
      const form = new FormData();
      form.append('name', new Blob([new Uint8Array(req.file.data)], { type: 'application/x-nzb' }), req.file.name || `${req.title || 'release'}.nzb`);
      r = await this.api<Raw>({ mode: 'addfile', cat, nzbname: req.title || '' }, { method: 'POST', body: form, timeoutMs: 60000 });
    } else if (req.url) {
      r = await this.api<Raw>({ mode: 'addurl', name: req.url, cat, nzbname: req.title || '' }, { timeoutMs: 60000 });
    } else {
      throw new Error('SABnzbd can only add NZB files or URLs');
    }
    if (r.status === false) throw new Error(`SABnzbd refused the NZB${r.error ? `: ${r.error}` : ''}`);
    return { id: r.nzo_ids?.[0] };
  }

  private async ensureCategory(cat: string): Promise<void> {
    try {
      const r = await this.api<Raw>({ mode: 'get_cats' });
      if ((r.categories || []).includes(cat)) return;
      await this.api({ mode: 'set_config', section: 'categories', keyword: cat, name: cat, dir: cat });
    } catch {
      /* falls back to the default category */
    }
  }

  async pause(id: string): Promise<void> {
    await this.api({ mode: 'queue', name: 'pause', value: id });
  }

  async resume(id: string): Promise<void> {
    await this.api({ mode: 'queue', name: 'resume', value: id });
  }

  async pauseAll(): Promise<void> {
    await this.api({ mode: 'pause' });
  }

  async resumeAll(): Promise<void> {
    await this.api({ mode: 'resume' });
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const del = deleteFiles ? 1 : 0;
    await this.api({ mode: 'queue', name: 'delete', value: id, del_files: del });
    await this.api({ mode: 'history', name: 'delete', value: id, del_files: del });
  }

  async downloadDirs(): Promise<string[]> {
    const r = await this.api<Raw>({ mode: 'get_config', section: 'misc' });
    const misc = r?.config?.misc || {};
    const dirs = [misc.complete_dir as string].filter(Boolean);
    const cats = await this.api<Raw>({ mode: 'get_config', section: 'categories' }).catch(() => ({}) as Raw);
    for (const c of (cats?.config?.categories || []) as Raw[]) {
      if (c.dir && String(c.dir).startsWith('/')) dirs.push(c.dir);
    }
    // relative category folders live below complete_dir
    return dirs.filter((d) => d.startsWith('/'));
  }

  async setAltSpeed(): Promise<void> {
    throw new Error('SABnzbd does not support alternative speed limits');
  }
}
