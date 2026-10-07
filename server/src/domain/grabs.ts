/*
 * "Download anything": search every indexer through Prowlarr, send the release straight to a
 * download client, then post-process it:
 *   - music      -> copied/hard-linked into the music library, Navidrome/Jellyfin rescan
 *   - audiobooks -> into the audiobook library, Audiobookshelf/Jellyfin rescan
 *   - anything else (apps, ebooks, games ...) -> offered as a browser download in Files
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SERVICE_NAMES, getSettings, type ClientId, type ImportMode } from '../config.js';
import { JsonStore } from '../store.js';
import { TtlMap, invalidate } from '../util/cache.js';
import { HttpError } from '../util/http.js';
import { moduleLogger } from '../log.js';
import { clientFor, need, services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { AddRequest, DownloadItem } from '../services/clients/types.js';
import type { GrabKind, GrabStatus, GrabView, ReleaseView } from '../types.js';
import { mapClientPath, parseReleaseName, safeName } from './paths.js';

const log = moduleLogger('grabs');

interface GrabRecord {
  id: string;
  title: string;
  kind: GrabKind;
  client: ClientId | 'prowlarr';
  downloadId?: string;
  protocol: 'torrent' | 'usenet';
  indexer?: string;
  size?: number;
  addedAt: string;
  updatedAt: string;
  importedAt?: string;
  status: GrabStatus;
  contentPath?: string;
  destination?: string;
  error?: string;
  listenUrl?: string;
  listenApp?: string;
  user?: string;
}

const store = new JsonStore<{ grabs: GrabRecord[] }>('grabs.json', () => ({ grabs: [] }));
const liveProgress = new Map<string, number>();

/* ------------------------------------------------------------------ */
/* Indexer search                                                      */
/* ------------------------------------------------------------------ */

export const SEARCH_CATEGORIES: Record<string, { label: string; ids: number[] }> = {
  all: { label: 'Everything', ids: [] },
  music: { label: 'Music', ids: [3000] },
  audiobooks: { label: 'Audiobooks', ids: [3030] },
  books: { label: 'Books & comics', ids: [7000] },
  software: { label: 'Software', ids: [4000] },
  games: { label: 'Games', ids: [1000, 4050] },
  movies: { label: 'Movies', ids: [2000] },
  tv: { label: 'TV', ids: [5000] },
  other: { label: 'Other', ids: [8000] },
};

// Search results stay on the server (their links contain indexer API keys)
const releaseCache = new TtlMap<Raw>(2 * 60 * 60 * 1000, 5000);

export function detectKind(categories: { id: number; name?: string }[] = []): GrabKind {
  const ids = categories.map((c) => c.id);
  const names = categories.map((c) => (c.name || '').toLowerCase()).join(' | ');
  if (ids.includes(3030) || /audio\s?books?/.test(names)) return 'audiobook';
  if (ids.some((id) => id >= 3000 && id < 4000)) return 'music';
  if (/\b(music|audio|flac|mp3|lossless)\b/.test(names) && !/video|movie|tv/.test(names)) return 'music';
  return 'files';
}

function releaseView(r: Raw): ReleaseView {
  const cats = ((r.categories || []) as Raw[]).map((c) => ({ id: c.id as number, name: c.name as string }));
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexer,
    title: r.title,
    size: r.size || 0,
    protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
    seeders: r.seeders ?? undefined,
    leechers: r.leechers ?? undefined,
    ageHours: typeof r.ageHours === 'number' ? Math.round(r.ageHours) : typeof r.age === 'number' ? r.age * 24 : undefined,
    publishDate: r.publishDate,
    infoUrl: r.infoUrl || r.commentUrl || undefined,
    categories: cats,
    kind: detectKind(cats),
    grabs: r.grabs ?? undefined,
  };
}

export async function indexerSearch(query: string, category: string): Promise<ReleaseView[]> {
  const prowlarr = need(services().prowlarr, 'Prowlarr');
  const cats = SEARCH_CATEGORIES[category]?.ids ?? [];
  const results = await prowlarr.search(query, cats, 100);
  const views = results.map((r) => {
    releaseCache.set(`${r.indexerId}:${r.guid}`, r);
    return releaseView(r);
  });
  // best first: usenet has no seeders, rank by grabs; torrents by seeders
  return views.sort((a, b) => (b.seeders ?? b.grabs ?? 0) - (a.seeders ?? a.grabs ?? 0));
}

/* ------------------------------------------------------------------ */
/* Grab                                                                */
/* ------------------------------------------------------------------ */

function categoryFor(kind: GrabKind): string {
  const prefix = getSettings().general.categoryPrefix || 'aio';
  return `${prefix}-${kind}`;
}

export async function grab(guid: string, indexerId: number, kindOverride: GrabKind | undefined, user?: string): Promise<GrabView> {
  const r = releaseCache.get(`${indexerId}:${guid}`);
  if (!r) throw new HttpError('This search result has expired - please search again.', 410);
  const kind = kindOverride || detectKind(r.categories);
  const protocol: 'torrent' | 'usenet' = r.protocol === 'usenet' ? 'usenet' : 'torrent';
  const prowlarr = need(services().prowlarr, 'Prowlarr');
  const client = clientFor(protocol);
  const now = new Date().toISOString();

  if (!client) {
    // No client configured in AIO Arr: let Prowlarr send it to its own client (no post-processing).
    await prowlarr.grab(guid, indexerId);
    const rec: GrabRecord = {
      id: crypto.randomUUID(),
      title: r.title,
      kind,
      client: 'prowlarr',
      protocol,
      indexer: r.indexer,
      size: r.size,
      addedAt: now,
      updatedAt: now,
      status: 'completed',
      error: `Sent via Prowlarr - add your ${protocol === 'usenet' ? 'usenet' : 'torrent'} client in Settings to enable automatic import`,
      user,
    };
    saveNew(rec);
    return toView(rec);
  }

  const req: AddRequest = { category: categoryFor(kind), title: r.title };
  try {
    if (r.downloadUrl) {
      const f = await prowlarr.fetchRelease(r.downloadUrl);
      if (f.magnet) req.magnet = f.magnet;
      else if (f.data) req.file = { name: f.fileName || `${safeName(r.title)}.${protocol === 'usenet' ? 'nzb' : 'torrent'}`, data: f.data };
    }
  } catch (err) {
    if (!r.magnetUrl) throw new HttpError(`Could not download the release from the indexer: ${(err as Error).message}`, 502);
  }
  if (!req.magnet && !req.file) {
    if (r.magnetUrl) req.magnet = r.magnetUrl;
    else throw new HttpError('This release has no download link', 400);
  }

  const res = await client.add(req);
  const rec: GrabRecord = {
    id: crypto.randomUUID(),
    title: r.title,
    kind,
    client: client.id,
    downloadId: res.id,
    protocol,
    indexer: r.indexer,
    size: r.size,
    addedAt: now,
    updatedAt: now,
    status: 'downloading',
    user,
  };
  saveNew(rec);
  log.info(`Sent "${r.title}" to ${client.name} as ${kind}`);
  invalidate('downloads');
  setTimeout(() => void tick(), 5000);
  return toView(rec);
}

function saveNew(rec: GrabRecord): void {
  store.update((d) => {
    d.grabs.unshift(rec);
    d.grabs = d.grabs.slice(0, 500);
  });
}

function patch(id: string, changes: Partial<GrabRecord>): void {
  store.update((d) => {
    const g = d.grabs.find((x) => x.id === id);
    if (g) Object.assign(g, changes, { updatedAt: new Date().toISOString() });
  });
}

/* ------------------------------------------------------------------ */
/* Views & management                                                  */
/* ------------------------------------------------------------------ */

function toView(g: GrabRecord): GrabView {
  const finished = g.status === 'imported' || g.status === 'completed';
  const dlPath = g.status === 'imported' ? g.destination : g.status === 'completed' ? g.contentPath : undefined;
  return {
    id: g.id,
    title: g.title,
    kind: g.kind,
    client: g.client,
    clientName: g.client === 'prowlarr' ? 'Prowlarr' : SERVICE_NAMES[g.client] || g.client,
    downloadId: g.downloadId,
    protocol: g.protocol,
    indexer: g.indexer,
    size: g.size,
    addedAt: g.addedAt,
    updatedAt: g.updatedAt,
    status: g.status,
    progress: finished ? 1 : liveProgress.get(g.id),
    contentPath: g.contentPath,
    destination: g.destination,
    error: g.error,
    listenUrl: g.listenUrl,
    listenApp: g.listenApp,
    downloadUrl: dlPath ? `/api/files/download?path=${encodeURIComponent(dlPath)}` : undefined,
  };
}

export function grabViews(): GrabView[] {
  return store.read().grabs.map(toView);
}

export function knownGrabPaths(): string[] {
  return store
    .read()
    .grabs.flatMap((g) => [g.contentPath, g.destination])
    .filter((p): p is string => !!p);
}

export function removeGrab(id: string): void {
  store.update((d) => {
    d.grabs = d.grabs.filter((g) => g.id !== id);
  });
  liveProgress.delete(id);
}

export function clearFinishedGrabs(): void {
  store.update((d) => {
    d.grabs = d.grabs.filter((g) => !['imported', 'completed', 'failed', 'removed'].includes(g.status));
  });
}

/** Re-run post-processing, optionally as a different kind (e.g. "send this download to my music library"). */
export function retryGrab(id: string, kind?: GrabKind): GrabView {
  const g = store.read().grabs.find((x) => x.id === id);
  if (!g) throw new HttpError('Download not found', 404);
  if (g.client === 'prowlarr') throw new HttpError('This download was handled by Prowlarr and cannot be processed here', 409);
  patch(id, { kind: kind || g.kind, status: 'downloading', error: undefined, listenUrl: undefined, listenApp: undefined });
  setTimeout(() => void tick(), 500);
  return toView(store.read().grabs.find((x) => x.id === id)!);
}

/* ------------------------------------------------------------------ */
/* Import (copy / hardlink / move)                                     */
/* ------------------------------------------------------------------ */

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.alac', '.aiff', '.aif', '.ape', '.wv', '.dsf', '.dff', '.mka', '.mp2', '.mpc', '.tta', '.aax',
]);
const EXTRA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.cue', '.log', '.lrc', '.pdf', '.m3u', '.m3u8', '.nfo', '.opf']);

async function walk(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function transfer(src: string, dest: string, mode: Exclude<ImportMode, 'auto'>): Promise<void> {
  const copy = () => fs.copyFile(src, dest, fs.constants.COPYFILE_FICLONE);
  if (mode === 'copy') return copy();
  if (mode === 'hardlink') {
    try {
      await fs.link(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EMLINK') await copy();
      else throw err;
    }
    return;
  }
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copy();
      await fs.unlink(src);
    } else throw err;
  }
}

export interface ImportResult {
  dest: string;
  files: number;
}

/** Put the audio files of a finished download into the music / audiobook library. */
export async function importAudio(src: string, kind: 'music' | 'audiobook', protocol: 'torrent' | 'usenet' | 'local'): Promise<ImportResult> {
  const p = getSettings().paths;
  const root = kind === 'audiobook' ? p.audiobooks || p.music : p.music || p.audiobooks;
  if (!root) throw new Error(`No ${kind === 'audiobook' ? 'audiobook' : 'music'} folder configured (Settings > Paths)`);
  let st;
  try {
    st = await fs.stat(src);
  } catch {
    throw new Error(`Downloaded files not found at ${src}. Mount the downloads folder into AIO Arr at the same path (or add a path mapping).`);
  }
  const files = st.isDirectory() ? await walk(src) : [src];
  const audio = files.filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));
  if (!audio.length) {
    const archives = files.some((f) => /\.(zip|rar|7z|r\d\d)$/i.test(f));
    throw new Error(archives ? 'Only archives found - extract them first, then retry' : 'No audio files found in this download');
  }
  const keep = files.filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()) || EXTRA_EXT.has(path.extname(f).toLowerCase()));
  const baseName = st.isDirectory() ? path.basename(src) : path.basename(src, path.extname(src));
  const parsed = parseReleaseName(baseName);
  // Audiobookshelf understands "Author/Title"; music players read tags, keep the release name
  const destDir =
    kind === 'audiobook' && parsed.artist
      ? path.join(root, safeName(parsed.artist), safeName(parsed.title))
      : path.join(root, safeName(st.isDirectory() ? baseName : parsed.artist ? `${parsed.artist} - ${parsed.title}` : parsed.title));

  const configured = p.importMode;
  const mode: Exclude<ImportMode, 'auto'> =
    configured !== 'auto' ? configured : protocol === 'torrent' ? 'hardlink' : protocol === 'usenet' ? 'move' : 'copy';

  let count = 0;
  for (const f of keep) {
    const rel = st.isDirectory() ? path.relative(src, f) : path.basename(f);
    const dest = path.join(destDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      const existing = await fs.stat(dest);
      const srcStat = await fs.stat(f);
      if (existing.size === srcStat.size) {
        count++;
        continue;
      }
    } catch {
      /* not there yet */
    }
    await transfer(f, dest, mode);
    count++;
  }
  log.info(`Imported ${count} files (${mode}) from ${src} to ${destDir}`);
  return { dest: destDir, files: count };
}

async function triggerScans(kind: 'music' | 'audiobook', dest: string): Promise<void> {
  const s = services();
  const tasks: Promise<unknown>[] = [];
  if (kind === 'music' && s.navidrome) tasks.push(s.navidrome.startScan());
  if (kind === 'audiobook' && s.audiobookshelf) tasks.push(s.audiobookshelf.scanForPath(dest));
  if (s.jellyfin) tasks.push(s.jellyfin.notifyPaths([dest]));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') log.warn('Library scan request failed:', r.reason?.message || r.reason);
}

async function resolveListenUrl(g: GrabRecord): Promise<{ url?: string; app?: string }> {
  const s = services();
  const parsed = parseReleaseName(path.basename(g.destination || g.title));
  const title = parsed.title;
  if (g.kind === 'music') {
    if (s.navidrome) {
      const id = await s.navidrome.findAlbum(title, parsed.artist).catch(() => undefined);
      if (id) return { url: s.navidrome.albumUrl(id), app: 'Navidrome' };
    }
  } else if (s.audiobookshelf) {
    const id = await s.audiobookshelf.findItem(title).catch(() => undefined);
    if (id) return { url: s.audiobookshelf.itemUrl(id), app: 'Audiobookshelf' };
  }
  if (s.jellyfin) {
    const res = await s.jellyfin.search(title).catch(() => undefined);
    const hit = res?.Items?.find((i) => ['MusicAlbum', 'AudioBook', 'Book', 'Audio'].includes(i.Type));
    if (hit) return { url: s.jellyfin.itemUrl(hit.Id, await s.jellyfin.getServerId().catch(() => undefined)), app: 'Jellyfin' };
  }
  return {};
}

function fallbackListen(kind: GrabKind): { url?: string; app?: string } {
  const s = services();
  if (kind === 'music' && s.navidrome) return { url: s.navidrome.publicUrl, app: 'Navidrome' };
  if (kind === 'audiobook' && s.audiobookshelf) return { url: s.audiobookshelf.publicUrl, app: 'Audiobookshelf' };
  if (s.jellyfin) return { url: s.jellyfin.publicUrl, app: 'Jellyfin' };
  return {};
}

/* ------------------------------------------------------------------ */
/* Post-processor loop                                                 */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function findItem(g: GrabRecord, items: DownloadItem[]): DownloadItem | undefined {
  if (g.downloadId) {
    const id = g.downloadId.toLowerCase();
    const hit = items.find((i) => i.id.toLowerCase() === id || i.altIds?.some((a) => a.toLowerCase() === id));
    if (hit) return hit;
  }
  const t = norm(g.title);
  return items.find((i) => norm(i.name) === t) || items.find((i) => t.length > 8 && (norm(i.name).includes(t) || t.includes(norm(i.name))));
}

let running = false;
let tickCount = 0;
const lastImport: Partial<Record<'radarr' | 'sonarr' | 'lidarr', string>> = {};

async function processGrab(g: GrabRecord, items: DownloadItem[]): Promise<void> {
  const item = findItem(g, items);
  if (!item) {
    if (g.status === 'downloading' && Date.now() - Date.parse(g.addedAt) > 30 * 60 * 1000) {
      patch(g.id, { status: 'removed', error: 'No longer present in the download client' });
    }
    return;
  }
  if (!g.downloadId) patch(g.id, { downloadId: item.id });
  if (item.state === 'failed' || (item.state === 'error' && !item.done)) {
    patch(g.id, { status: 'failed', error: item.message || 'The download failed' });
    return;
  }
  liveProgress.set(g.id, item.progress);
  if (!item.done) return;

  const local = mapClientPath(item.contentPath);
  if (!local) {
    patch(g.id, { status: 'failed', error: 'The download client did not report where the files are' });
    return;
  }
  if (g.kind === 'files') {
    try {
      await fs.stat(local);
      patch(g.id, { status: 'completed', contentPath: local, error: undefined });
    } catch {
      patch(g.id, {
        status: 'completed',
        contentPath: local,
        error: `Finished, but ${local} is not visible inside AIO Arr - check the downloads volume / path mappings`,
      });
    }
    log.info(`"${g.title}" is ready to download`);
    return;
  }
  patch(g.id, { status: 'importing', contentPath: local });
  try {
    const res = await importAudio(local, g.kind, item.protocol);
    patch(g.id, { status: 'imported', destination: res.dest, importedAt: new Date().toISOString(), error: undefined });
    await triggerScans(g.kind, res.dest);
  } catch (err) {
    patch(g.id, { status: 'failed', error: (err as Error).message });
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const all = store.read().grabs;
    const active = all.filter((g) => (g.status === 'downloading' || g.status === 'queued' || g.status === 'importing') && g.client !== 'prowlarr');
    const byClient = new Map<string, GrabRecord[]>();
    for (const g of active) byClient.set(g.client, [...(byClient.get(g.client) || []), g]);
    for (const [clientId, list] of byClient) {
      const client = services().clients.find((c) => c.id === clientId);
      if (!client) continue;
      let items: DownloadItem[];
      try {
        items = await client.list();
      } catch (err) {
        log.debug(`post-processor: ${client.name} unavailable`, (err as Error).message);
        continue;
      }
      for (const g of list) {
        try {
          await processGrab(g, items);
        } catch (err) {
          log.error(`post-processing "${g.title}" failed`, err);
        }
      }
      invalidate('downloads');
    }

    // Find "listen" links for freshly imported audio (scans take a moment)
    for (const g of store.read().grabs) {
      if (g.status !== 'imported' || g.listenUrl) continue;
      const age = Date.now() - Date.parse(g.importedAt || g.updatedAt);
      if (age < 10_000) continue;
      const found = await resolveListenUrl(g).catch(() => ({}) as { url?: string; app?: string });
      if (found.url) patch(g.id, { listenUrl: found.url, listenApp: found.app });
      else if (age > 10 * 60 * 1000) {
        const fb = fallbackListen(g.kind);
        patch(g.id, { listenUrl: fb.url || '', listenApp: fb.app });
      }
    }

    if (tickCount++ % 2 === 0) await watchArrImports();
  } finally {
    running = false;
  }
}

/**
 * When Radarr / Sonarr / Lidarr import something, tell Jellyfin (and Navidrome) right away so the
 * "Watch" / "Listen" links work without waiting for a scheduled library scan.
 */
async function watchArrImports(): Promise<void> {
  const s = services();
  if (!s.jellyfin && !s.navidrome) return;
  const folders = new Set<string>();
  let music = false;
  for (const id of ['radarr', 'sonarr', 'lidarr'] as const) {
    const svc = s[id];
    if (!svc) continue;
    try {
      const page = await svc.history({ pageSize: 20 });
      const imports = (page.records || []).filter((r) => /imported/i.test(String(r.eventType)));
      const newest = imports[0]?.date as string | undefined;
      if (!newest) {
        lastImport[id] ??= ''; // nothing imported yet: everything from now on is new
        continue;
      }
      const since = lastImport[id];
      lastImport[id] = newest > (since || '') ? newest : since;
      if (since === undefined) continue; // first run only records where we are
      for (const r of imports) {
        if (r.date <= since) continue;
        const p = r.data?.importedPath as string | undefined;
        if (p) folders.add(path.dirname(p));
        if (id === 'lidarr') music = true;
      }
    } catch {
      /* service offline */
    }
  }
  if (!folders.size && !music) return;
  log.info(`New imports detected (${folders.size} folders) - notifying media servers`);
  if (folders.size && s.jellyfin) {
    await s.jellyfin.notifyPaths([...folders]).catch((err) => log.debug('Jellyfin notify failed', (err as Error).message));
    const jf = s.jellyfin;
    // give Jellyfin a moment to scan, then rebuild the id -> item index used for "Watch" links
    setTimeout(() => {
      jf.invalidateIndex();
      invalidate('lib:', 'jf:');
    }, 20_000).unref();
  }
  if (music && s.navidrome) await s.navidrome.startScan().catch(() => undefined);
}

let timer: NodeJS.Timeout | undefined;

export function startPostProcessor(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  setTimeout(() => void tick(), 3000).unref();
}

export function stopPostProcessor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
