import type { ClientId } from '../../config.js';
import type { TestResult } from '../base.js';

export type DownloadState =
  | 'downloading'
  | 'seeding'
  | 'completed'
  | 'paused'
  | 'queued'
  | 'stalled'
  | 'checking'
  | 'processing'
  | 'metadata'
  | 'failed'
  | 'error';

export type Protocol = 'torrent' | 'usenet';

export interface DownloadItem {
  client: ClientId;
  clientName: string;
  protocol: Protocol;
  /** torrent hash (lowercase), SABnzbd nzo_id or NZBGet NZBID */
  id: string;
  /** Other ids the *arr apps may use for this download (NZBGet "drone" parameter). */
  altIds?: string[];
  name: string;
  category: string;
  state: DownloadState;
  /** Raw state from the client (for tooltips). */
  rawState: string;
  /** 0..1 */
  progress: number;
  size: number;
  downloaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  /** seconds, null when unknown */
  eta: number | null;
  ratio?: number;
  seeds?: number;
  peers?: number;
  addedAt?: string;
  completedAt?: string;
  /** Path of the downloaded content as seen by the download client. */
  contentPath?: string;
  message?: string;
  /** Download (and client-side post-processing) finished successfully. */
  done: boolean;
  paused: boolean;
  /** Item lives in history (usenet) - can only be removed. */
  inHistory?: boolean;
}

export interface ClientStats {
  downloadSpeed: number;
  uploadSpeed: number;
  /** Alternative (turtle) speed limits active; undefined if unsupported. */
  altSpeed?: boolean;
  paused?: boolean;
  version?: string;
}

export interface AddRequest {
  magnet?: string;
  url?: string;
  file?: { name: string; data: Buffer };
  category: string;
  title?: string;
}

export interface AddResult {
  /** hash / nzo_id / NZBID when known */
  id?: string;
}

export interface DownloadClient {
  readonly id: ClientId;
  readonly name: string;
  readonly protocol: Protocol;
  readonly publicUrl: string;
  readonly supportsAltSpeed: boolean;
  test(): Promise<TestResult>;
  list(): Promise<DownloadItem[]>;
  stats(): Promise<ClientStats>;
  add(req: AddRequest): Promise<AddResult>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string, deleteFiles: boolean): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  setAltSpeed(enabled: boolean): Promise<void>;
  /** Folders the client saves completed downloads to (client paths). */
  downloadDirs(): Promise<string[]>;
}

export function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p));
}

export function etaOrNull(seconds: number | undefined | null): number | null {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds >= 8640000) return null;
  return Math.round(seconds);
}

export function isoFromUnix(sec: number | undefined | null): string | undefined {
  if (!sec || sec <= 0) return undefined;
  return new Date(sec * 1000).toISOString();
}

/** "1:02:03" -> 3723, "2:01:02:03" (d:h:m:s) -> 176523 */
export function parseHms(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.length > 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [d, h, m, sec] = parts.length === 4 ? parts : [0, ...[0, 0, 0, ...parts].slice(-3)];
  return d * 86400 + h * 3600 + m * 60 + sec;
}
