/* Browse finished downloads and hand them to the browser (single files with resume support, folders as ZIP). */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSettings } from '../config.js';
import { cached } from '../util/cache.js';
import { HttpError } from '../util/http.js';
import { planZip, zipStream, type ZipEntry } from '../util/zip.js';
import { services } from '../services/registry.js';
import type { FileEntry } from '../types.js';
import { isInside, mapClientPath } from './paths.js';
import { knownGrabPaths } from './grabs.js';

export interface RootView {
  path: string;
  label: string;
  kind: 'downloads' | 'music' | 'audiobooks' | 'download';
  free?: number;
  total?: number;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Download folders reported by the configured clients, translated to local paths and filtered to what is mounted. */
function discoveredDownloadRoots(): Promise<string[]> {
  return cached('files:discovered-roots', 5 * 60_000, async () => {
    const found = new Set<string>();
    await Promise.all(
      services().clients.map(async (c) => {
        try {
          for (const d of await c.downloadDirs()) {
            const local = mapClientPath(d);
            if (local && (await isDir(local))) found.add(path.resolve(local));
          }
        } catch {
          /* client offline */
        }
      }),
    );
    // collapse nested folders into their parent
    const list = [...found].sort((a, b) => a.length - b.length);
    return list.filter((p, i) => !list.slice(0, i).some((q) => isInside(p, q)));
  });
}

export async function fileRoots(): Promise<RootView[]> {
  const p = getSettings().paths;
  const roots: RootView[] = [];
  const downloads = p.downloads.length ? p.downloads : await discoveredDownloadRoots();
  for (const d of downloads) roots.push({ path: path.resolve(d), label: downloads.length > 1 ? `Downloads · ${path.basename(d)}` : 'Downloads', kind: 'downloads' });
  if (p.music) roots.push({ path: path.resolve(p.music), label: 'Music library', kind: 'music' });
  if (p.audiobooks) roots.push({ path: path.resolve(p.audiobooks), label: 'Audiobooks library', kind: 'audiobooks' });
  const unique = roots.filter((r, i) => roots.findIndex((x) => x.path === r.path) === i);
  const out: RootView[] = [];
  for (const r of unique) {
    if (!(await isDir(r.path))) continue;
    try {
      const s = await fs.statfs(r.path);
      r.free = s.bavail * s.bsize;
      r.total = s.blocks * s.bsize;
    } catch {
      /* statfs unsupported */
    }
    out.push(r);
  }
  return out;
}

/** Resolve a user supplied path and make sure it lives inside an allowed root (symlinks resolved). */
export async function resolveAllowed(input: unknown): Promise<{ real: string; root: RootView }> {
  if (typeof input !== 'string' || !input || !path.isAbsolute(input) || input.includes('\0')) throw new HttpError('Invalid path', 400);
  let real: string;
  try {
    real = await fs.realpath(path.resolve(input));
  } catch {
    throw new HttpError('File not found', 404);
  }
  for (const r of await fileRoots()) {
    const rr = await fs.realpath(r.path).catch(() => r.path);
    if (isInside(real, rr)) return { real, root: r };
  }
  for (const gp of knownGrabPaths()) {
    const rr = await fs.realpath(gp).catch(() => undefined);
    if (rr && isInside(real, rr)) return { real, root: { path: gp, label: 'Download', kind: 'download' } };
  }
  throw new HttpError('This location is outside the folders AIO Arr may share', 403);
}

export async function listDir(input: string): Promise<{ path: string; parent?: string; root: RootView; entries: FileEntry[] }> {
  const { real, root } = await resolveAllowed(input);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new HttpError('Not a folder', 400);
  const dirents = await fs.readdir(real, { withFileTypes: true });
  const entries: FileEntry[] = [];
  await Promise.all(
    dirents.slice(0, 5000).map(async (d) => {
      if (d.name.startsWith('.')) return;
      const full = path.join(real, d.name);
      try {
        const s = await fs.stat(full);
        entries.push({ name: d.name, path: full, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtime.toISOString() });
      } catch {
        /* broken symlink */
      }
    }),
  );
  entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
  const rootReal = await fs.realpath(root.path).catch(() => root.path);
  const parent = real === rootReal ? undefined : path.dirname(real);
  return { path: real, parent, root, entries };
}

/* ------------------------------ sending ------------------------------ */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.iso': 'application/x-iso9660-image',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.dmg': 'application/x-apple-diskimage',
  '.apk': 'application/vnd.android.package-archive',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.nfo': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

// Only these may be shown inline in the browser; everything else is forced to download.
const INLINE_SAFE = /^(video|audio|image\/(jpeg|png|gif|webp)|application\/pdf|text\/plain)/;

function disposition(type: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function collect(dir: string, base: string, out: ZipEntry[], depth = 0): Promise<void> {
  if (depth > 20) return;
  if (out.length > 50000) throw new HttpError('Folder has too many files to zip', 413);
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) await collect(full, `${base}/${d.name}`, out, depth + 1);
    else if (d.isFile()) {
      const s = await fs.stat(full);
      out.push({ name: `${base}/${d.name}`, path: full, size: s.size, mtime: s.mtime });
    }
  }
}

export async function sendPath(request: FastifyRequest, reply: FastifyReply, input: string, inline = false): Promise<FastifyReply> {
  const { real } = await resolveAllowed(input);
  const st = await fs.stat(real);
  const name = path.basename(real);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');

  if (st.isDirectory()) {
    const entries: ZipEntry[] = [];
    await collect(real, name, entries);
    const plan = planZip(entries);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', disposition('attachment', `${name}.zip`));
    reply.header('Content-Length', String(plan.totalSize));
    return reply.send(Readable.from(zipStream(plan)));
  }

  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const showInline = inline && INLINE_SAFE.test(type);
  reply.header('Content-Type', type);
  reply.header('Content-Disposition', disposition(showInline ? 'inline' : 'attachment', name));
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Last-Modified', st.mtime.toUTCString());
  if (showInline) reply.header('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox");

  const total = st.size;
  const range = request.headers.range;
  if (range && total > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (!m[1]) {
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      }
      if (start <= end && start < total) {
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
        reply.header('Content-Length', String(end - start + 1));
        return reply.send(createReadStream(real, { start, end }));
      }
    }
    reply.code(416);
    reply.header('Content-Range', `bytes */${total}`);
    return reply.send();
  }
  reply.header('Content-Length', String(total));
  return reply.send(createReadStream(real));
}

export async function deletePath(input: string): Promise<void> {
  const { real, root } = await resolveAllowed(input);
  const rootReal = await fs.realpath(root.path).catch(() => root.path);
  if (real === rootReal) throw new HttpError('Refusing to delete a root folder', 400);
  await fs.rm(real, { recursive: true, force: true });
}
