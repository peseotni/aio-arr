import type { ServiceConfig } from '../../config.js';
import { BaseService, type TestResult } from '../base.js';
import { ServiceError, type RequestOptions } from '../../util/http.js';
import { magnetInfoHash, torrentInfoHash } from '../../util/torrent.js';
import {
  clampProgress,
  etaOrNull,
  isoFromUnix,
  type AddRequest,
  type AddResult,
  type ClientStats,
  type DownloadClient,
  type DownloadItem,
  type DownloadState,
} from './types.js';

type Raw = Record<string, any>;

const STATE_MAP: Record<string, DownloadState> = {
  error: 'error',
  missingFiles: 'error',
  uploading: 'seeding',
  forcedUP: 'seeding',
  stalledUP: 'seeding',
  queuedUP: 'seeding',
  checkingUP: 'checking',
  pausedUP: 'completed',
  stoppedUP: 'completed',
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  stalledDL: 'stalled',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  queuedDL: 'queued',
  checkingDL: 'checking',
  checkingResumeData: 'checking',
  allocating: 'checking',
  moving: 'processing',
  unknown: 'queued',
};

function versionAtLeast(v: string, min: number[]): boolean {
  const parts = v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export class QBittorrentClient extends BaseService implements DownloadClient {
  readonly protocol = 'torrent' as const;
  readonly supportsAltSpeed = true;
  private cookie?: string;
  private apiVersion?: string;

  declare readonly id: 'qbittorrent';

  constructor(cfg: ServiceConfig) {
    super('qbittorrent', 'qBittorrent', cfg);
  }

  private async login(): Promise<void> {
    if (!this.cfg.username && !this.cfg.password) return; // auth bypass for local network
    const res = await this.request<Response>('/api/v2/auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: this.cfg.username, password: this.cfg.password }),
      headers: { Referer: this.baseUrl },
      responseType: 'raw',
      timeoutMs: 10000,
    });
    const text = await res.text().catch(() => '');
    if (res.status === 403) throw new ServiceError('qBittorrent: too many failed logins - the WebUI banned this IP for a while', this.name, 403);
    if (!res.ok || /fails/i.test(text)) throw new ServiceError('qBittorrent: login failed - check username/password', this.name, 401);
    const cookies = res.headers.getSetCookie?.() || [];
    const sid = cookies.map((c) => c.split(';')[0]).find((c) => /SID/i.test(c));
    if (sid) this.cookie = sid;
  }

  private async call<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.cookie && (this.cfg.username || this.cfg.password)) await this.login();
    const exec = () =>
      this.request<T>(`/api/v2/${path}`, {
        ...opts,
        headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), Referer: this.baseUrl, ...opts.headers },
      });
    try {
      return await exec();
    } catch (err) {
      if (err instanceof ServiceError && (err.upstreamStatus === 403 || err.upstreamStatus === 401)) {
        this.cookie = undefined;
        await this.login();
        return exec();
      }
      throw err;
    }
  }

  private async webApiVersion(): Promise<string> {
    if (!this.apiVersion) this.apiVersion = await this.call<string>('app/webapiVersion', { responseType: 'text' });
    return this.apiVersion!;
  }

  async test(): Promise<TestResult> {
    const version = await this.call<string>('app/version', { responseType: 'text', timeoutMs: 10000 });
    return { ok: true, version, message: `qBittorrent ${version}` };
  }

  async list(): Promise<DownloadItem[]> {
    const torrents = await this.call<Raw[]>('torrents/info');
    return (torrents || []).map((t) => this.map(t));
  }

  private map(t: Raw): DownloadItem {
    const state = STATE_MAP[t.state as string] ?? 'queued';
    const progress = clampProgress(t.progress);
    const done = progress >= 1 && !['checking', 'processing', 'error', 'metadata'].includes(state);
    return {
      client: 'qbittorrent',
      clientName: this.name,
      protocol: 'torrent',
      id: String(t.hash).toLowerCase(),
      name: t.name,
      category: t.category || '',
      state,
      rawState: t.state,
      progress,
      size: t.size || t.total_size || 0,
      // "completed" counts data on disk; "downloaded" is only what this session transferred
      downloaded: t.completed ?? Math.round((t.size || 0) * progress),
      downloadSpeed: t.dlspeed || 0,
      uploadSpeed: t.upspeed || 0,
      eta: state === 'downloading' ? etaOrNull(t.eta) : null,
      ratio: typeof t.ratio === 'number' ? t.ratio : undefined,
      seeds: t.num_seeds,
      peers: t.num_leechs,
      addedAt: isoFromUnix(t.added_on),
      completedAt: isoFromUnix(t.completion_on),
      contentPath: t.content_path || (t.save_path ? `${String(t.save_path).replace(/\/+$/, '')}/${t.name}` : undefined),
      message: state === 'error' ? `qBittorrent reports ${t.state}` : undefined,
      done,
      paused: /^(paused|stopped)/.test(t.state),
    };
  }

  async stats(): Promise<ClientStats> {
    const [info, mode] = await Promise.all([
      this.call<Raw>('transfer/info', { timeoutMs: 10000 }),
      this.call<string>('transfer/speedLimitsMode', { responseType: 'text', timeoutMs: 10000 }).catch(() => '0'),
    ]);
    return {
      downloadSpeed: info?.dl_info_speed || 0,
      uploadSpeed: info?.up_info_speed || 0,
      altSpeed: String(mode).trim() === '1',
    };
  }

  private async ensureCategory(category: string): Promise<void> {
    if (!category) return;
    try {
      const cats = await this.call<Record<string, unknown>>('torrents/categories');
      if (cats && Object.prototype.hasOwnProperty.call(cats, category)) return;
      await this.call('torrents/createCategory', { method: 'POST', body: new URLSearchParams({ category, savePath: '' }), responseType: 'text' });
    } catch {
      /* category creation is best effort */
    }
  }

  async add(req: AddRequest): Promise<AddResult> {
    await this.ensureCategory(req.category);
    const form = new FormData();
    let hash: string | undefined;
    if (req.file) {
      form.append('torrents', new Blob([new Uint8Array(req.file.data)], { type: 'application/x-bittorrent' }), req.file.name || 'release.torrent');
      hash = torrentInfoHash(req.file.data);
    } else if (req.magnet || req.url) {
      form.append('urls', (req.magnet || req.url)!);
      if (req.magnet) hash = magnetInfoHash(req.magnet);
    } else {
      throw new Error('Nothing to add');
    }
    if (req.category) form.append('category', req.category);
    form.append('tags', 'aio-arr');
    const res = await this.call<unknown>('torrents/add', { method: 'POST', body: form, responseType: 'text', timeoutMs: 30000 });
    const text = typeof res === 'string' ? res.trim() : '';
    if (/^fails/i.test(text)) throw new Error('qBittorrent refused the torrent (duplicate or invalid)');
    if (text.startsWith('{')) {
      try {
        const data = JSON.parse(text) as { added_torrent_ids?: string[]; failure_count?: number; success_count?: number };
        if (data.added_torrent_ids?.length) hash = data.added_torrent_ids[0].toLowerCase();
        else if (data.failure_count && !data.success_count) throw new Error('qBittorrent refused the torrent (duplicate or invalid)');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('qBittorrent')) throw err;
      }
    }
    return { id: hash };
  }

  private async action(kind: 'pause' | 'resume', hashes: string): Promise<void> {
    const modern = versionAtLeast(await this.webApiVersion(), [2, 11]);
    const endpoint = kind === 'pause' ? (modern ? 'stop' : 'pause') : modern ? 'start' : 'resume';
    await this.call(`torrents/${endpoint}`, { method: 'POST', body: new URLSearchParams({ hashes }), responseType: 'text' });
  }

  pause(id: string): Promise<void> {
    return this.action('pause', id);
  }

  resume(id: string): Promise<void> {
    return this.action('resume', id);
  }

  pauseAll(): Promise<void> {
    return this.action('pause', 'all');
  }

  resumeAll(): Promise<void> {
    return this.action('resume', 'all');
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    await this.call('torrents/delete', {
      method: 'POST',
      body: new URLSearchParams({ hashes: id, deleteFiles: String(deleteFiles) }),
      responseType: 'text',
    });
  }

  async downloadDirs(): Promise<string[]> {
    const [prefs, cats] = await Promise.all([
      this.call<Raw>('app/preferences'),
      this.call<Record<string, Raw>>('torrents/categories').catch(() => ({}) as Record<string, Raw>),
    ]);
    const dirs = [prefs?.save_path as string];
    for (const c of Object.values(cats || {})) if (c.savePath) dirs.push(c.savePath as string);
    return dirs.filter(Boolean);
  }

  async setAltSpeed(enabled: boolean): Promise<void> {
    const mode = await this.call<string>('transfer/speedLimitsMode', { responseType: 'text' });
    if ((String(mode).trim() === '1') !== enabled) {
      await this.call('transfer/toggleSpeedLimitsMode', { method: 'POST', responseType: 'text' });
    }
  }
}
