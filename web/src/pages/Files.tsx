import clsx from 'clsx';
import {
  AppWindow,
  Archive,
  BookHeadphones,
  BookOpen,
  ChevronRight,
  Download,
  Eye,
  File,
  FileText,
  Film,
  Folder,
  FolderOpen,
  HardDrive,
  Image,
  Music,
  Search,
  Trash,
} from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, qs } from '../lib/api';
import { bytes, relative } from '../lib/format';
import { useApp, useFileList, useFileRoots, useGrabs, type RootView } from '../lib/queries';
import { useRouter } from '../lib/router';
import type { FileEntry } from '../lib/types';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, EmptyState, ErrorNote, IconButton, PageHeader, Progress, SectionHeader, Skeleton } from '../components/ui';

const EXT: [RegExp, ComponentType<{ className?: string }>, string][] = [
  [/\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts)$/i, Film, 'text-accent'],
  [/\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav|wma|alac|aiff|ape)$/i, Music, 'text-ok'],
  [/\.(zip|rar|7z|tar|gz|bz2|xz|r\d\d|iso|img)$/i, Archive, 'text-warn'],
  [/\.(jpg|jpeg|png|gif|webp|bmp)$/i, Image, 'text-info'],
  [/\.(epub|mobi|azw3|pdf|cbz|cbr|djvu)$/i, BookOpen, 'text-info'],
  [/\.(exe|msi|dmg|pkg|apk|appimage|deb|rpm)$/i, AppWindow, 'text-fg'],
  [/\.(txt|nfo|srt|ass|sub|log|md|json|xml)$/i, FileText, 'text-muted'],
];

function iconFor(e: FileEntry): [ComponentType<{ className?: string }>, string] {
  if (e.isDir) return [Folder, 'text-accent'];
  for (const [re, icon, color] of EXT) if (re.test(e.name)) return [icon, color];
  return [File, 'text-muted'];
}

const PREVIEWABLE = /\.(mp4|m4v|webm|mp3|m4a|m4b|aac|ogg|opus|flac|wav|pdf|jpg|jpeg|png|gif|webp|txt|nfo)$/i;

function dlUrl(path: string, inline = false): string {
  return `/api/files/download${qs({ path, inline: inline ? 1 : undefined })}`;
}

function RootCard({ r, active, onClick }: { r: RootView; active: boolean; onClick: () => void }) {
  const used = r.total && r.free !== undefined ? 1 - r.free / r.total : undefined;
  const Icon = r.kind === 'music' ? Music : r.kind === 'audiobooks' ? BookHeadphones : HardDrive;
  return (
    <button type="button" onClick={onClick} className={clsx('card flex items-center gap-3 p-3.5 text-left transition-colors hover:bg-card-hover', active && 'ring-2 ring-accent/60')}>
      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{r.label}</div>
        <div className="truncate font-mono text-[11px] text-subtle">{r.path}</div>
        {used !== undefined && (
          <div className="mt-1.5 flex items-center gap-2">
            <Progress value={used} tone={used > 0.9 ? 'bad' : used > 0.8 ? 'warn' : 'accent'} />
            <span className="shrink-0 text-[11px] text-muted">{bytes(r.free)} free</span>
          </div>
        )}
      </div>
    </button>
  );
}

export function FilesPage() {
  const { search, navigate } = useRouter();
  const { data: roots, isLoading: rootsLoading, error: rootsError } = useFileRoots();
  const { data: app } = useApp();
  const { data: grabs } = useGrabs();
  const isAdmin = app?.user.role === 'admin';
  const path = search.get('path') || roots?.[0]?.path;
  const { data, isLoading, error } = useFileList(path);
  const [text, setText] = useState('');
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const go = (p: string) => navigate(`/files?path=${encodeURIComponent(p)}`);
  const crumbs = useMemo(() => {
    if (!data) return [];
    const root = data.root.path.replace(/\/+$/, '');
    const rel = data.path.startsWith(root) ? data.path.slice(root.length) : '';
    const parts = rel.split('/').filter(Boolean);
    return [{ label: data.root.label, path: root }, ...parts.map((p, i) => ({ label: p, path: `${root}/${parts.slice(0, i + 1).join('/')}` }))];
  }, [data]);

  const entries = useMemo(() => {
    const t = text.trim().toLowerCase();
    const list = (data?.entries || []).filter((e) => !t || e.name.toLowerCase().includes(t));
    return [...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.mtime.localeCompare(a.mtime));
  }, [data, text]);

  const readyGrabs = (grabs || []).filter((g) => g.status === 'completed' && g.kind === 'files' && g.downloadUrl).slice(0, 6);

  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      void qc.invalidateQueries({ queryKey: ['files'] });
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={FolderOpen} title="Files" subtitle="Browse finished downloads and save them to this device" />

      {readyGrabs.length > 0 && (
        <section>
          <SectionHeader title="Ready to download" icon={Download} subtitle="Apps, ebooks and other files you grabbed" />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {readyGrabs.map((g) => (
              <a key={g.id} href={g.downloadUrl} download className="card flex items-center gap-3 p-3 transition-colors hover:bg-card-hover">
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok/12 text-ok">
                  <Download className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{g.title}</div>
                  <div className="text-xs text-muted">{g.size ? bytes(g.size) : ''} · finished {relative(g.updatedAt)}</div>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {rootsError && <ErrorNote>{errorMessage(rootsError)}</ErrorNote>}
      {rootsLoading ? (
        <Skeleton className="h-20" />
      ) : !roots?.length ? (
        <EmptyState icon={HardDrive} title="No folders to show">
          Mount your downloads folder into the AIO Arr container (for example <code className="font-mono">/data</code>) and add it under Settings → Paths, or connect a download client so AIO Arr can find it automatically.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {roots.map((r) => (
              <RootCard key={r.path} r={r} active={data?.root.path === r.path} onClick={() => go(r.path)} />
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="flex shrink-0 items-center gap-1">
                    {i > 0 && <ChevronRight className="size-3.5 text-subtle" />}
                    <button type="button" onClick={() => go(c.path)} className={clsx('rounded-md px-1.5 py-0.5 hover:bg-card-hover', i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted')}>
                      {c.label}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                <input className="input h-9 pl-9" placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              {data && data.path !== data.root.path && (
                <a href={dlUrl(data.path)} download>
                  <Button size="sm" variant="secondary" icon={Download}>
                    Download folder
                  </Button>
                </a>
              )}
            </div>
            {error && <ErrorNote className="m-3">{errorMessage(error)}</ErrorNote>}
            {isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : !entries.length ? (
              <div className="py-12 text-center text-sm text-muted">This folder is empty.</div>
            ) : (
              <div className="divide-y divide-line">
                {entries.map((e) => {
                  const [Icon, color] = iconFor(e);
                  const audioLike = e.isDir || /\.(mp3|flac|m4a|m4b|aac|ogg|opus)$/i.test(e.name);
                  return (
                    <div key={e.path} className="group flex items-center gap-3 px-3 py-2 hover:bg-card-hover">
                      <button type="button" disabled={!e.isDir} onClick={() => e.isDir && go(e.path)} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
                        <Icon className={clsx('size-5 shrink-0', color)} />
                        <span className="truncate text-sm" title={e.name}>
                          {e.name}
                        </span>
                      </button>
                      <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted sm:block">{e.isDir ? '' : bytes(e.size)}</span>
                      <span className="hidden w-28 shrink-0 text-right text-xs text-subtle md:block">{relative(e.mtime)}</span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {!e.isDir && PREVIEWABLE.test(e.name) && (
                          <a href={dlUrl(e.path, true)} target="_blank" rel="noreferrer" title="Open in browser" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-card hover:text-fg">
                            <Eye className="size-4" />
                          </a>
                        )}
                        <a href={dlUrl(e.path)} download title={e.isDir ? 'Download as ZIP' : 'Download'} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-card hover:text-fg">
                          <Download className="size-4" />
                        </a>
                        {isAdmin && audioLike && data?.root.kind === 'downloads' && (
                          <>
                            <IconButton icon={Music} size="sm" label="Add to music library" loading={busy === `m${e.path}`} onClick={() => void act(`m${e.path}`, () => api.post('/api/files/import', { path: e.path, kind: 'music' }), 'Added to your music library')} />
                            <IconButton icon={BookHeadphones} size="sm" label="Add to audiobooks" loading={busy === `a${e.path}`} onClick={() => void act(`a${e.path}`, () => api.post('/api/files/import', { path: e.path, kind: 'audiobook' }), 'Added to your audiobooks')} />
                          </>
                        )}
                        {isAdmin && (
                          <IconButton
                            icon={Trash}
                            size="sm"
                            label="Delete"
                            loading={busy === `d${e.path}`}
                            onClick={async () => {
                              const ok = await confirm({ title: `Delete ${e.isDir ? 'folder' : 'file'}?`, message: <span className="break-all">{e.name}</span>, confirmLabel: 'Delete', danger: true });
                              if (ok) await act(`d${e.path}`, () => api.del(`/api/files${qs({ path: e.path })}`), 'Deleted');
                            }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {data && (
              <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-subtle">
                <span>
                  {entries.filter((e) => e.isDir).length} folders · {entries.filter((e) => !e.isDir).length} files
                </span>
                <Badge>{bytes(entries.reduce((n, e) => n + e.size, 0))}</Badge>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
