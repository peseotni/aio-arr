/*
 * "Download anything": search every indexer through Prowlarr, send the release straight to a
 * download client, then post-process it according to Settings > Open with:
 *   - music      -> into the music library, Navidrome / Jellyfin / Plex rescan
 *   - audiobooks -> into the audiobook library, Audiobookshelf / Jellyfin rescan
 *   - ebooks     -> into the books library, Kavita / Komga / Audiobookshelf rescan
 *   - comics     -> into the comics library (one folder per series), Komga / Kavita rescan
 *   - anything else (apps, games ...) -> offered as a browser download in Files
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SERVICE_NAMES, getSettings, type ClientId, type ContentType, type ImportMode } from '../config.js';
import { JsonStore } from '../store.js';
import { TtlMap, invalidate } from '../util/cache.js';
import { HttpError } from '../util/http.js';
import { moduleLogger } from '../log.js';
import { clientFor, need, services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { AddRequest, DownloadItem } from '../services/clients/types.js';
import type { GrabKind, GrabStatus, GrabView, PlayLink, ReleaseView } from '../types.js';
import { mapClientPath, parseReleaseName, safeName } from './paths.js';
import { CATEGORIES, classify, torznabFor } from './categories.js';
import { parseRelease } from './parse.js';
import { findByTitle, homeLink, invalidatePlayerIndexes, keepAsDownload, notifyImported } from './players.js';

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
  play?: PlayLink;
  /** search category it came from */
  category?: ContentType;
  user?: string;
  /** set once we gave up looking for the item in the player app */
  playChecked?: boolean;
  /** the library was picked by hand ("Download as"): import even if "Open with" says download */
  toLibrary?: boolean;
  /** older records */
  listenUrl?: string;
  listenApp?: string;
}

const store = new JsonStore<{ grabs: GrabRecord[] }>('grabs.json', () => ({ grabs: [] }));
const liveProgress = new Map<string, number>();

/* ------------------------------------------------------------------ */
/* Indexer search                                                      */
/* ------------------------------------------------------------------ */

// Search results stay on the server (their links contain indexer API keys)
const releaseCache = new TtlMap<Raw>(2 * 60 * 60 * 1000, 5000);

/** What happens with a download of these indexer categories. */
export function detectKind(categories: { id: number; name?: string }[] = []): GrabKind {
  return CATEGORIES[classify(categories)].kind;
}

/** Content type of a grab kind (for "open with"). */
export function contentOfKind(kind: GrabKind, category?: ContentType): ContentType {
  return kind === 'music' ? 'music' : kind === 'audiobook' ? 'audiobooks' : kind === 'ebook' ? 'ebooks' : kind === 'comic' ? 'comics' : category || 'other';
}

function releaseView(r: Raw): ReleaseView {
  const cats = ((r.categories || []) as Raw[]).map((c) => ({ id: c.id as number, name: c.name as string }));
  const category = classify(cats);
  const ids = {
    imdb: r.imdbId ? `tt${String(r.imdbId).replace(/^tt/, '').padStart(7, '0')}` : undefined,
    tmdb: r.tmdbId || undefined,
    tvdb: r.tvdbId || undefined,
  };
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
    kind: CATEGORIES[category].kind,
    grabs: r.grabs ?? undefined,
    category,
    parsed: parseRelease(r.title, category, ids.imdb || ids.tmdb || ids.tvdb ? ids : undefined),
    poster: typeof r.posterUrl === 'string' && /^https?:\/\//.test(r.posterUrl) ? r.posterUrl : undefined,
  };
}

/** Search every indexer in the chosen categories. Results are classified and filtered to those categories. */
export async function indexerSearch(query: string, cats: ContentType[]): Promise<ReleaseView[]> {
  const prowlarr = need(services().prowlarr, 'Prowlarr');
  const wanted = new Set(cats);
  const all = cats.length >= Object.keys(CATEGORIES).length;
  const results = await prowlarr.search(query, all ? [] : torznabFor(cats), 100);
  const views: ReleaseView[] = [];
  for (const r of results) {
    const v = releaseView(r);
    // "Music" also matches audiobooks (both are 3xxx), "Software" also games (4050): keep what was asked for
    if (!all && !wanted.has(v.category!)) continue;
    releaseCache.set(`${r.indexerId}:${r.guid}`, r);
    views.push(v);
  }
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

/** A library picked by hand needs its folder. */
function requireLibrary(kind: GrabKind | undefined): void {
  if (kind && kind !== 'files' && !libraryRoot(kind)) {
    throw new HttpError(`Set a ${LIBRARY[kind].label} folder under Settings > Open with first (or download it as files)`, 409);
  }
}

export async function grab(guid: string, indexerId: number, kindOverride: GrabKind | undefined, user?: string): Promise<GrabView> {
  const r = releaseCache.get(`${indexerId}:${guid}`);
  if (!r) throw new HttpError('This search result has expired - please search again.', 410);
  requireLibrary(kindOverride);
  const category = classify(r.categories);
  const kind = kindOverride || CATEGORIES[category].kind;
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
      category,
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
    category,
    user,
    toLibrary: !!kindOverride && kindOverride !== 'files',
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
    play: g.play || (g.listenUrl ? { app: (g.listenApp || 'app').toLowerCase(), name: g.listenApp || 'app', url: g.listenUrl, verb: 'Listen' } : undefined),
    downloadUrl: dlPath ? `/api/files/download?path=${encodeURIComponent(dlPath)}` : undefined,
    category: g.category,
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
  requireLibrary(kind);
  patch(id, {
    kind: kind || g.kind,
    toLibrary: kind ? kind !== 'files' : g.toLibrary,
    status: 'downloading',
    error: undefined,
    play: undefined,
    playChecked: undefined,
    listenUrl: undefined,
    listenApp: undefined,
  });
  setTimeout(() => void tick(), 500);
  return toView(store.read().grabs.find((x) => x.id === id)!);
}

/* ------------------------------------------------------------------ */
/* Import (copy / hardlink / move)                                     */
/* ------------------------------------------------------------------ */

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.alac', '.aiff', '.aif', '.ape', '.wv', '.dsf', '.dff', '.mka', '.mp2', '.mpc', '.tta', '.aax',
]);
const EBOOK_EXT = new Set(['.epub', '.mobi', '.azw', '.azw3', '.kfx', '.pdf', '.fb2', '.djvu', '.cbz', '.lit', '.txt', '.rtf', '.docx']);
const COMIC_EXT = new Set(['.cbz', '.cbr', '.cb7', '.cbt', '.zip', '.rar', '.7z', '.pdf', '.epub']);
const EXTRA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.cue', '.log', '.lrc', '.pdf', '.m3u', '.m3u8', '.nfo', '.opf']);

export type LibraryKind = Exclude<GrabKind, 'files'>;

const LIBRARY: Record<LibraryKind, { label: string; ext: Set<string>; extras: Set<string>; setting: 'music' | 'audiobooks' | 'ebooks' | 'comics' }> = {
  music: { label: 'music', ext: AUDIO_EXT, extras: EXTRA_EXT, setting: 'music' },
  audiobook: { label: 'audiobook', ext: AUDIO_EXT, extras: EXTRA_EXT, setting: 'audiobooks' },
  ebook: { label: 'books', ext: EBOOK_EXT, extras: new Set(['.jpg', '.jpeg', '.png', '.opf']), setting: 'ebooks' },
  comic: { label: 'comics', ext: COMIC_EXT, extras: new Set(), setting: 'comics' },
};

/** Library folder for a kind ('' if not configured). Music and audiobooks fall back to each other like before. */
export function libraryRoot(kind: LibraryKind): string {
  const p = getSettings().paths;
  switch (kind) {
    case 'music':
      return p.music || p.audiobooks || '';
    case 'audiobook':
      return p.audiobooks || p.music || '';
    case 'ebook':
      return p.ebooks || '';
    case 'comic':
      return p.comics || '';
  }
}

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

/** Where in the library a download goes. */
export function destinationFor(kind: LibraryKind, root: string, baseName: string, isDir: boolean): { dir: string; flat: boolean } {
  if (kind === 'comic') {
    // Komga / Kavita: one folder per series, issues directly inside
    const c = parseRelease(baseName, 'comics');
    return { dir: path.join(root, safeName(c.title)), flat: true };
  }
  const parsed = parseReleaseName(baseName);
  if (kind === 'audiobook' || kind === 'ebook') {
    // Audiobookshelf / Kavita / Komga understand "Author/Title"
    if (parsed.artist) return { dir: path.join(root, safeName(parsed.artist), safeName(parsed.title)), flat: false };
    // no author in the name: at least a clean title ("The Pragmatic Programmer", not "... 20th Anniversary EPUB")
    const clean = parseRelease(baseName, kind === 'ebook' ? 'ebooks' : 'audiobooks');
    if (clean.artist) return { dir: path.join(root, safeName(clean.artist), safeName(clean.title)), flat: false };
    return { dir: path.join(root, safeName(clean.title || baseName)), flat: false };
  }
  // music players read tags: keep the release name
  return { dir: path.join(root, safeName(isDir ? baseName : parsed.artist ? `${parsed.artist} - ${parsed.title}` : parsed.title)), flat: false };
}

/**
 * Put the files of a finished download into the music / audiobook / book / comic library.
 * `releaseName` (the indexer title) names the library folder - the download itself may be a lone file.
 */
export async function importToLibrary(src: string, kind: LibraryKind, protocol: 'torrent' | 'usenet' | 'local', releaseName?: string): Promise<ImportResult> {
  const lib = LIBRARY[kind];
  const root = libraryRoot(kind);
  if (!root) throw new Error(`No ${lib.label} folder configured (Settings > Open with)`);
  let st;
  try {
    st = await fs.stat(src);
  } catch {
    throw new Error(`Downloaded files not found at ${src}. Mount the downloads folder into AIO Arr at the same path (or add a path mapping).`);
  }
  const files = st.isDirectory() ? await walk(src) : [src];
  const main = files.filter((f) => lib.ext.has(path.extname(f).toLowerCase()));
  if (!main.length) {
    const archives = files.some((f) => /\.(zip|rar|7z|r\d\d)$/i.test(f));
    throw new Error(archives && kind !== 'comic' ? 'Only archives found - extract them first, then retry' : `No ${lib.label} files found in this download`);
  }
  const keep = files.filter((f) => lib.ext.has(path.extname(f).toLowerCase()) || lib.extras.has(path.extname(f).toLowerCase()));
  const baseName = releaseName || (st.isDirectory() ? path.basename(src) : path.basename(src, path.extname(src)));
  const { dir: destDir, flat } = destinationFor(kind, root, baseName, st.isDirectory() || !!releaseName);

  const configured = getSettings().paths.importMode;
  const mode: Exclude<ImportMode, 'auto'> =
    configured !== 'auto' ? configured : protocol === 'torrent' ? 'hardlink' : protocol === 'usenet' ? 'move' : 'copy';

  let count = 0;
  for (const f of keep) {
    const rel = st.isDirectory() && !flat ? path.relative(src, f) : path.basename(f);
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

/** Kept for the "send to library" action in Files. */
export const importAudio = (src: string, kind: 'music' | 'audiobook', protocol: 'torrent' | 'usenet' | 'local') => importToLibrary(src, kind, protocol);

/** Find the imported item in the app that opens it ("Listen in Navidrome", "Read in Komga"). */
async function resolvePlayLink(g: GrabRecord): Promise<PlayLink | undefined> {
  const type = contentOfKind(g.kind, g.category);
  const name = path.basename(g.destination || g.title);
  if (g.kind === 'comic') return findByTitle(type, parseRelease(name, 'comics').title, undefined);
  const parsed = parseReleaseName(name);
  return findByTitle(type, parsed.title, parsed.artist);
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
  const type = contentOfKind(g.kind, g.category);
  const libraryKind = g.kind === 'files' ? undefined : g.kind;
  // "Download to this computer" chosen for this type (unless a library was picked by hand), or no library folder: keep it as files
  const asFiles = !libraryKind || (!g.toLibrary && keepAsDownload(type)) || !libraryRoot(libraryKind);
  if (asFiles) {
    let note: string | undefined;
    try {
      await fs.stat(local);
      if (libraryKind && !keepAsDownload(type)) note = `Ready to download - set a ${LIBRARY[libraryKind].label} folder under Settings > Open with to add these to your library automatically`;
    } catch {
      note = `Finished, but ${local} is not visible inside AIO Arr - check the downloads volume / path mappings`;
    }
    patch(g.id, { status: 'completed', contentPath: local, error: note });
    log.info(`"${g.title}" is ready to download`);
    return;
  }
  patch(g.id, { status: 'importing', contentPath: local });
  try {
    const res = await importToLibrary(local, libraryKind, item.protocol, g.title);
    patch(g.id, { status: 'imported', destination: res.dest, importedAt: new Date().toISOString(), error: undefined });
    await notifyImported(type, [res.dest]);
    invalidatePlayerIndexes();
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

    // Find "listen / read" links for fresh imports (library scans take a moment)
    for (const g of store.read().grabs) {
      if (g.status !== 'imported' || g.play || g.playChecked || g.listenUrl) continue;
      const age = Date.now() - Date.parse(g.importedAt || g.updatedAt);
      if (age < 10_000) continue;
      const found = await resolvePlayLink(g).catch(() => undefined);
      if (found) patch(g.id, { play: found });
      else if (age > 10 * 60 * 1000) patch(g.id, { play: homeLink(contentOfKind(g.kind, g.category)), playChecked: true });
    }

    if (tickCount++ % 2 === 0) await watchArrImports();
  } finally {
    running = false;
  }
}

/**
 * When Radarr / Sonarr / Lidarr import something, tell the media servers right away so the
 * "Watch" / "Listen" links work without waiting for a scheduled library scan.
 */
async function watchArrImports(): Promise<void> {
  const s = services();
  if (!s.jellyfin && !s.emby && !s.plex && !s.navidrome) return;
  const folders: Record<'movies' | 'tv' | 'music', Set<string>> = { movies: new Set(), tv: new Set(), music: new Set() };
  const TYPE = { radarr: 'movies', sonarr: 'tv', lidarr: 'music' } as const;
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
        if (p) folders[TYPE[id]].add(path.dirname(p));
      }
    } catch {
      /* service offline */
    }
  }
  const total = folders.movies.size + folders.tv.size + folders.music.size;
  if (!total) return;
  log.info(`New imports detected (${total} folders) - notifying media servers`);
  await Promise.all((Object.keys(folders) as ('movies' | 'tv' | 'music')[]).map((t) => notifyImported(t, [...folders[t]])));
  // give the servers a moment to scan, then rebuild the id -> item indexes used for "Watch" links
  setTimeout(() => {
    invalidatePlayerIndexes();
    invalidate('lib:', 'jf:', 'recs:');
  }, 20_000).unref();
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
