import type { ServiceConfig } from '../../config.js';
import { BaseService, type TestResult } from '../base.js';
import { ServiceError } from '../../util/http.js';
import {
  clampProgress,
  isoFromUnix,
  type AddRequest,
  type AddResult,
  type ClientStats,
  type DownloadClient,
  type DownloadItem,
  type DownloadState,
} from './types.js';

type Raw = Record<string, any>;

const QUEUE_STATE: Record<string, DownloadState> = {
  QUEUED: 'queued',
  PAUSED: 'paused',
  DOWNLOADING: 'downloading',
  FETCHING: 'metadata',
  PP_QUEUED: 'processing',
  LOADING_PARS: 'processing',
  VERIFYING_SOURCES: 'processing',
  REPAIRING: 'processing',
  VERIFYING_REPAIRED: 'processing',
  RENAMING: 'processing',
  UNPACKING: 'processing',
  MOVING: 'processing',
  EXECUTING_SCRIPT: 'processing',
  PP_FINISHED: 'processing',
};

const mb = (lo: number | undefined, hi: number | undefined, sizeMb?: number) =>
  lo !== undefined ? (hi || 0) * 4294967296 + lo : Math.round((sizeMb || 0) * 1048576);

/** Sonarr/Radarr tag NZBs with a "drone" parameter and use it as their download id. */
const droneIds = (g: Raw): string[] | undefined => {
  const ids = ((g.Parameters || []) as Raw[]).filter((p) => p.Name === 'drone' && p.Value).map((p) => String(p.Value));
  return ids.length ? ids : undefined;
};

export class NzbgetClient extends BaseService implements DownloadClient {
  readonly protocol = 'usenet' as const;
  readonly supportsAltSpeed = false;
  declare readonly id: 'nzbget';

  constructor(cfg: ServiceConfig) {
    super('nzbget', 'NZBGet', cfg);
  }

  override headers(): Record<string, string> {
    return this.cfg.username || this.cfg.password
      ? { Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}` }
      : {};
  }

  private async rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const r = await this.request<Raw>(/\/jsonrpc$/.test(this.baseUrl) ? '' : '/jsonrpc', {
      method: 'POST',
      body: { method, params, id: 1 },
      timeoutMs: 30000,
    });
    if (r?.error) throw new ServiceError(`NZBGet: ${r.error.message || JSON.stringify(r.error)}`, this.name);
    return r?.result as T;
  }

  async test(): Promise<TestResult> {
    const v = await this.rpc<string>('version');
    return { ok: true, version: v, message: `NZBGet ${v}` };
  }

  async list(): Promise<DownloadItem[]> {
    const [groups, history, status] = await Promise.all([this.rpc<Raw[]>('listgroups', [0]), this.rpc<Raw[]>('history', [false]), this.rpc<Raw>('status')]);
    const rate = status?.DownloadRate || 0;
    let firstActive = true;
    const queue = (groups || []).map((g): DownloadItem => {
      const size = mb(g.FileSizeLo, g.FileSizeHi, g.FileSizeMB);
      const remaining = mb(g.RemainingSizeLo, g.RemainingSizeHi, g.RemainingSizeMB);
      let state = QUEUE_STATE[g.Status as string] ?? 'queued';
      if (state === 'downloading' && status?.DownloadPaused) state = 'paused';
      const speed = state === 'downloading' && firstActive ? rate : 0;
      if (state === 'downloading') firstActive = false;
      return {
        client: 'nzbget',
        clientName: this.name,
        protocol: 'usenet',
        id: String(g.NZBID),
        altIds: droneIds(g),
        name: g.NZBName,
        category: g.Category || '',
        state,
        rawState: g.Status,
        progress: clampProgress(size ? (size - remaining) / size : 0),
        size,
        downloaded: size - remaining,
        downloadSpeed: speed,
        uploadSpeed: 0,
        eta: speed > 0 ? Math.round(remaining / speed) : null,
        done: false,
        paused: g.Status === 'PAUSED',
      };
    });
    const hist = (history || [])
      .filter((h) => h.Kind === undefined || h.Kind === 'NZB')
      .slice(0, 60)
      .map((h): DownloadItem => {
        const status = String(h.Status || '');
        const ok = status.startsWith('SUCCESS') || status.startsWith('WARNING');
        const failed = status.startsWith('FAILURE') || status.startsWith('DELETED');
        const size = mb(h.FileSizeLo, h.FileSizeHi, h.FileSizeMB);
        return {
          client: 'nzbget',
          clientName: this.name,
          protocol: 'usenet',
          id: String(h.NZBID),
          altIds: droneIds(h),
          name: h.Name,
          category: h.Category || '',
          state: ok ? 'completed' : failed ? 'failed' : 'processing',
          rawState: status,
          progress: failed ? 0 : 1,
          size,
          downloaded: size,
          downloadSpeed: 0,
          uploadSpeed: 0,
          eta: null,
          completedAt: isoFromUnix(h.HistoryTime),
          contentPath: h.FinalDir || h.DestDir || undefined,
          message: failed ? status : undefined,
          done: ok,
          paused: false,
          inHistory: true,
        };
      });
    return [...queue, ...hist];
  }

  async stats(): Promise<ClientStats> {
    const s = await this.rpc<Raw>('status');
    return { downloadSpeed: s?.DownloadRate || 0, uploadSpeed: 0, paused: !!s?.DownloadPaused };
  }

  async add(req: AddRequest): Promise<AddResult> {
    const name = req.file?.name || `${req.title || 'release'}.nzb`;
    const content = req.file ? req.file.data.toString('base64') : req.url;
    if (!content) throw new Error('NZBGet can only add NZB files or URLs');
    // append(NZBFilename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, PPParameters)
    const id = await this.rpc<number>('append', [name, content, req.category || '', 0, false, false, '', 0, 'SCORE', []]);
    if (!id || id <= 0) throw new Error('NZBGet refused the NZB');
    return { id: String(id) };
  }

  private async edit(command: string, id: string): Promise<void> {
    const ok = await this.rpc<boolean>('editqueue', [command, '', [Number(id)]]);
    if (!ok) throw new Error(`NZBGet: ${command} failed`);
  }

  pause(id: string): Promise<void> {
    return this.edit('GroupPause', id);
  }

  resume(id: string): Promise<void> {
    return this.edit('GroupResume', id);
  }

  async pauseAll(): Promise<void> {
    await this.rpc('pausedownload');
  }

  async resumeAll(): Promise<void> {
    await this.rpc('resumedownload');
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    // try queue first, then history
    const queueOk = await this.rpc<boolean>('editqueue', [deleteFiles ? 'GroupFinalDelete' : 'GroupDelete', '', [Number(id)]]).catch(() => false);
    if (!queueOk) await this.rpc<boolean>('editqueue', [deleteFiles ? 'HistoryFinalDelete' : 'HistoryDelete', '', [Number(id)]]);
  }

  async downloadDirs(): Promise<string[]> {
    const cfg = await this.rpc<{ Name: string; Value: string }[]>('config');
    const get = (n: string) => cfg.find((c) => c.Name === n)?.Value || '';
    const main = get('MainDir');
    const expand = (v: string) => v.replace(/\$\{MainDir\}/g, main);
    return [expand(get('DestDir'))].filter((d) => d.startsWith('/'));
  }

  async setAltSpeed(): Promise<void> {
    throw new Error('NZBGet does not support alternative speed limits');
  }
}
