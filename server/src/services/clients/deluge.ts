import type { ServiceConfig } from '../../config.js';
import { BaseService, type TestResult } from '../base.js';
import { ServiceError } from '../../util/http.js';
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

const FIELDS = [
  'name',
  'state',
  'progress',
  'total_wanted',
  'total_size',
  'total_done',
  'download_payload_rate',
  'upload_payload_rate',
  'eta',
  'ratio',
  'download_location',
  'save_path',
  'label',
  'time_added',
  'completed_time',
  'num_seeds',
  'num_peers',
  'message',
  'is_finished',
];

const STATE_MAP: Record<string, DownloadState> = {
  Downloading: 'downloading',
  Seeding: 'seeding',
  Paused: 'paused',
  Checking: 'checking',
  Queued: 'queued',
  Error: 'error',
  Moving: 'processing',
  Allocating: 'checking',
};

export class DelugeClient extends BaseService implements DownloadClient {
  readonly protocol = 'torrent' as const;
  readonly supportsAltSpeed = false;
  declare readonly id: 'deluge';
  private cookie = '';
  private seq = 0;
  private labelPlugin?: boolean;

  constructor(cfg: ServiceConfig) {
    super('deluge', 'Deluge', cfg);
  }

  private async raw<T>(method: string, params: unknown[]): Promise<{ result: T; error: { message: string; code: number } | null }> {
    const res = await this.request<Response>(/\/json$/.test(this.baseUrl) ? '' : '/json', {
      method: 'POST',
      body: { method, params, id: ++this.seq },
      headers: this.cookie ? { Cookie: this.cookie } : {},
      responseType: 'raw',
      timeoutMs: 20000,
    });
    const setCookie = res.headers.getSetCookie?.()[0];
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (!res.ok) throw new ServiceError(`Deluge: HTTP ${res.status}`, this.name, res.status);
    return (await res.json()) as { result: T; error: { message: string; code: number } | null };
  }

  private async login(): Promise<void> {
    const r = await this.raw<boolean>('auth.login', [this.cfg.password || 'deluge']);
    if (!r.result) throw new ServiceError('Deluge: login failed - check the WebUI password', this.name, 401);
    const connected = await this.raw<boolean>('web.connected', []);
    if (!connected.result) {
      const hosts = await this.raw<[string, string, number, string][]>('web.get_hosts', []);
      const host = hosts.result?.[0];
      if (!host) throw new ServiceError('Deluge: the WebUI has no daemon configured', this.name);
      await this.raw('web.connect', [host[0]]);
    }
  }

  private async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.cookie) await this.login();
    let r = await this.raw<T>(method, params);
    if (r.error && (r.error.code === 1 || /not authenticated/i.test(r.error.message))) {
      this.cookie = '';
      await this.login();
      r = await this.raw<T>(method, params);
    }
    if (r.error) throw new ServiceError(`Deluge: ${r.error.message}`, this.name);
    return r.result;
  }

  async test(): Promise<TestResult> {
    const version = await this.call<string>('daemon.get_version').catch(() => '');
    return { ok: true, version: version || undefined, message: `Deluge ${version}`.trim() };
  }

  async list(): Promise<DownloadItem[]> {
    const torrents = await this.call<Record<string, Raw>>('core.get_torrents_status', [{}, FIELDS]);
    return Object.entries(torrents || {}).map(([hash, t]) => this.map(hash, t));
  }

  private map(hash: string, t: Raw): DownloadItem {
    const progress = clampProgress((t.progress || 0) / 100);
    let state = STATE_MAP[t.state as string] ?? 'queued';
    if (state === 'paused' && progress >= 1) state = 'completed';
    if (state === 'downloading' && !t.download_payload_rate) state = 'stalled';
    const size = t.total_wanted || t.total_size || 0;
    const dir = (t.download_location || t.save_path || '') as string;
    return {
      client: 'deluge',
      clientName: this.name,
      protocol: 'torrent',
      id: hash.toLowerCase(),
      name: t.name,
      category: t.label || '',
      state,
      rawState: t.state,
      progress,
      size,
      downloaded: t.total_done || 0,
      downloadSpeed: t.download_payload_rate || 0,
      uploadSpeed: t.upload_payload_rate || 0,
      eta: state === 'downloading' ? etaOrNull(t.eta) : null,
      ratio: typeof t.ratio === 'number' && t.ratio >= 0 ? t.ratio : undefined,
      seeds: t.num_seeds,
      peers: t.num_peers,
      addedAt: isoFromUnix(t.time_added),
      completedAt: isoFromUnix(t.completed_time),
      contentPath: dir ? `${dir.replace(/\/+$/, '')}/${t.name}` : undefined,
      message: state === 'error' ? t.message : undefined,
      done: progress >= 1 && state !== 'checking' && state !== 'error' && state !== 'processing',
      paused: t.state === 'Paused',
    };
  }

  async stats(): Promise<ClientStats> {
    const [s, paused] = await Promise.all([
      this.call<Raw>('core.get_session_status', [['payload_download_rate', 'payload_upload_rate']]),
      this.call<boolean>('core.is_session_paused').catch(() => false),
    ]);
    return { downloadSpeed: s?.payload_download_rate || 0, uploadSpeed: s?.payload_upload_rate || 0, paused: !!paused };
  }

  private async applyLabel(hash: string, label: string): Promise<void> {
    if (!label) return;
    try {
      if (this.labelPlugin === undefined) {
        const plugins = await this.call<string[]>('core.get_enabled_plugins');
        this.labelPlugin = plugins.includes('Label');
      }
      if (!this.labelPlugin) return;
      const labels = await this.call<string[]>('label.get_labels');
      const lc = label.toLowerCase(); // Deluge labels are lowercase
      if (!labels.includes(lc)) await this.call('label.add', [lc]);
      await this.call('label.set_torrent', [hash, lc]);
    } catch {
      /* labels are optional */
    }
  }

  async add(req: AddRequest): Promise<AddResult> {
    const options = { add_paused: false };
    let hash: string | null = null;
    if (req.file) {
      hash = await this.call<string | null>('core.add_torrent_file', [req.file.name || 'release.torrent', req.file.data.toString('base64'), options]);
      hash ||= torrentInfoHash(req.file.data) ?? null;
    } else if (req.magnet) {
      hash = await this.call<string | null>('core.add_torrent_magnet', [req.magnet, options]);
      hash ||= magnetInfoHash(req.magnet) ?? null;
    } else if (req.url) {
      hash = await this.call<string | null>('core.add_torrent_url', [req.url, options]);
    } else {
      throw new Error('Nothing to add');
    }
    if (hash) await this.applyLabel(hash, req.category);
    return { id: hash ? hash.toLowerCase() : undefined };
  }

  async pause(id: string): Promise<void> {
    await this.call('core.pause_torrents', [[id]]);
  }

  async resume(id: string): Promise<void> {
    await this.call('core.resume_torrents', [[id]]);
  }

  async pauseAll(): Promise<void> {
    await this.call('core.pause_session');
  }

  async resumeAll(): Promise<void> {
    await this.call('core.resume_session');
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    await this.call('core.remove_torrent', [id, deleteFiles]);
  }

  async downloadDirs(): Promise<string[]> {
    const c = await this.call<Raw>('core.get_config_values', [['download_location', 'move_completed', 'move_completed_path']]);
    return [c?.download_location, c?.move_completed ? c?.move_completed_path : undefined].filter(Boolean) as string[];
  }

  async setAltSpeed(): Promise<void> {
    throw new Error('Deluge does not support alternative speed limits');
  }
}
