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
  'id',
  'hashString',
  'name',
  'status',
  'percentDone',
  'totalSize',
  'sizeWhenDone',
  'leftUntilDone',
  'downloadedEver',
  'rateDownload',
  'rateUpload',
  'eta',
  'uploadRatio',
  'downloadDir',
  'labels',
  'addedDate',
  'doneDate',
  'error',
  'errorString',
  'isFinished',
  'peersSendingToUs',
  'peersGettingFromUs',
  'metadataPercentComplete',
];

export class TransmissionClient extends BaseService implements DownloadClient {
  readonly protocol = 'torrent' as const;
  readonly supportsAltSpeed = true;
  declare readonly id: 'transmission';
  private sessionId = '';

  constructor(cfg: ServiceConfig) {
    super('transmission', 'Transmission', cfg);
  }

  private rpcPath(): string {
    // Allow either http://host:9091 or http://host:9091/transmission/rpc
    return /\/rpc$/.test(this.baseUrl) ? '' : '/transmission/rpc';
  }

  private async rpc<T = Raw>(method: string, args: Raw = {}): Promise<T> {
    const auth: Record<string, string> = this.cfg.username || this.cfg.password ? { Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}` } : {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.request<Response>(this.rpcPath(), {
        method: 'POST',
        body: { method, arguments: args },
        headers: { ...auth, 'X-Transmission-Session-Id': this.sessionId },
        responseType: 'raw',
        timeoutMs: 20000,
      });
      if (res.status === 409) {
        this.sessionId = res.headers.get('x-transmission-session-id') || '';
        continue;
      }
      if (res.status === 401) throw new ServiceError('Transmission: unauthorized - check username/password', this.name, 401);
      if (!res.ok) throw new ServiceError(`Transmission: HTTP ${res.status}`, this.name, res.status);
      const data = (await res.json()) as { result: string; arguments: T };
      if (data.result !== 'success') throw new ServiceError(`Transmission: ${data.result}`, this.name);
      return data.arguments;
    }
    throw new ServiceError('Transmission: could not obtain a session id', this.name);
  }

  async test(): Promise<TestResult> {
    const s = await this.rpc<Raw>('session-get', { fields: ['version', 'rpc-version'] });
    return { ok: true, version: s.version, message: `Transmission ${s.version}` };
  }

  async list(): Promise<DownloadItem[]> {
    const r = await this.rpc<{ torrents: Raw[] }>('torrent-get', { fields: FIELDS });
    return (r.torrents || []).map((t) => this.map(t));
  }

  private map(t: Raw): DownloadItem {
    const progress = clampProgress(t.percentDone);
    let state: DownloadState;
    switch (t.status) {
      case 0:
        state = progress >= 1 ? 'completed' : 'paused';
        break;
      case 1:
      case 2:
        state = 'checking';
        break;
      case 3:
        state = 'queued';
        break;
      case 4:
        state = t.metadataPercentComplete < 1 ? 'metadata' : t.rateDownload > 0 ? 'downloading' : 'stalled';
        break;
      case 5:
      case 6:
        state = 'seeding';
        break;
      default:
        state = 'queued';
    }
    if (t.error && t.error !== 0 && t.error !== 1) state = 'error'; // 1 = tracker warning
    const size = t.sizeWhenDone || t.totalSize || 0;
    return {
      client: 'transmission',
      clientName: this.name,
      protocol: 'torrent',
      id: String(t.hashString).toLowerCase(),
      name: t.name,
      category: Array.isArray(t.labels) && t.labels.length ? String(t.labels[0]) : '',
      state,
      rawState: String(t.status),
      progress,
      size,
      downloaded: Math.max(0, size - (t.leftUntilDone || 0)),
      downloadSpeed: t.rateDownload || 0,
      uploadSpeed: t.rateUpload || 0,
      eta: etaOrNull(t.eta),
      ratio: t.uploadRatio >= 0 ? t.uploadRatio : undefined,
      seeds: t.peersSendingToUs,
      peers: t.peersGettingFromUs,
      addedAt: isoFromUnix(t.addedDate),
      completedAt: isoFromUnix(t.doneDate),
      contentPath: t.downloadDir ? `${String(t.downloadDir).replace(/\/+$/, '')}/${t.name}` : undefined,
      message: t.errorString || undefined,
      done: progress >= 1 && (t.leftUntilDone || 0) === 0 && state !== 'checking' && state !== 'error',
      paused: t.status === 0,
    };
  }

  async stats(): Promise<ClientStats> {
    const [stats, session] = await Promise.all([this.rpc<Raw>('session-stats'), this.rpc<Raw>('session-get', { fields: ['alt-speed-enabled', 'version'] })]);
    return {
      downloadSpeed: stats.downloadSpeed || 0,
      uploadSpeed: stats.uploadSpeed || 0,
      altSpeed: !!session['alt-speed-enabled'],
      version: session.version,
    };
  }

  async add(req: AddRequest): Promise<AddResult> {
    const args: Raw = { paused: false };
    let hash: string | undefined;
    if (req.file) {
      args.metainfo = req.file.data.toString('base64');
      hash = torrentInfoHash(req.file.data);
    } else if (req.magnet || req.url) {
      args.filename = req.magnet || req.url;
      if (req.magnet) hash = magnetInfoHash(req.magnet);
    } else {
      throw new Error('Nothing to add');
    }
    if (req.category) args.labels = [req.category];
    let r: Raw;
    try {
      r = await this.rpc<Raw>('torrent-add', args);
    } catch (err) {
      if (args.labels && err instanceof ServiceError && /label/i.test(err.message)) {
        delete args.labels; // labels need Transmission 4+
        r = await this.rpc<Raw>('torrent-add', args);
      } else throw err;
    }
    const added = r['torrent-added'] || r['torrent-duplicate'];
    return { id: added?.hashString ? String(added.hashString).toLowerCase() : hash };
  }

  async pause(id: string): Promise<void> {
    await this.rpc('torrent-stop', { ids: [id] });
  }

  async resume(id: string): Promise<void> {
    await this.rpc('torrent-start', { ids: [id] });
  }

  async pauseAll(): Promise<void> {
    await this.rpc('torrent-stop', {});
  }

  async resumeAll(): Promise<void> {
    await this.rpc('torrent-start', {});
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    await this.rpc('torrent-remove', { ids: [id], 'delete-local-data': deleteFiles });
  }

  async downloadDirs(): Promise<string[]> {
    const s = await this.rpc<Raw>('session-get', { fields: ['download-dir'] });
    return [s['download-dir']].filter(Boolean);
  }

  async setAltSpeed(enabled: boolean): Promise<void> {
    await this.rpc('session-set', { 'alt-speed-enabled': enabled });
  }
}
