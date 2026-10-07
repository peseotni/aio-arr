import clsx from 'clsx';
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  BookHeadphones,
  CircleAlert,
  Download,
  ExternalLink,
  FileDown,
  Headphones,
  Music,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash,
  Turtle,
} from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { bytes, duration, pct, relative, speed } from '../lib/format';
import { useApp, useDownloads, useGrabs } from '../lib/queries';
import type { ClientSummary, DownloadView, GrabKind, GrabView } from '../lib/types';
import { Poster, downloadTitle } from '../components/media';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, EmptyState, ErrorNote, IconButton, PageHeader, Progress, SectionHeader, Skeleton, Tabs, type Tone } from '../components/ui';

type Filter = 'active' | 'done' | 'problems' | 'all';

const STATE: Record<string, { label: string; tone: Tone }> = {
  downloading: { label: 'Downloading', tone: 'accent' },
  metadata: { label: 'Fetching info', tone: 'info' },
  stalled: { label: 'Stalled', tone: 'warn' },
  checking: { label: 'Checking', tone: 'info' },
  queued: { label: 'Queued', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
  seeding: { label: 'Seeding', tone: 'ok' },
  completed: { label: 'Completed', tone: 'ok' },
  processing: { label: 'Processing', tone: 'info' },
  importing: { label: 'Importing', tone: 'info' },
  warning: { label: 'Needs attention', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  error: { label: 'Error', tone: 'bad' },
};

const KIND_ICON: Record<GrabKind, ComponentType<{ className?: string }>> = { music: Music, audiobook: BookHeadphones, files: AppWindow };

/** Release names that are probably audio, even when the indexer filed them elsewhere */
const AUDIO_HINT = /\b(mp3|flac|m4a|m4b|aac|ogg|opus|alac|320|v0|kbps|audiobook|album|discography|lossless|web-?flac)\b/i;

const isActive = (d: DownloadView) => ['downloading', 'metadata', 'stalled', 'checking', 'queued', 'paused', 'processing', 'importing'].includes(d.state) && !d.done;
const isProblem = (d: DownloadView) => ['failed', 'error', 'warning'].includes(d.state) || d.state === 'stalled';

function ClientCard({ c }: { c: ClientSummary }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: string, body?: unknown) => {
    setBusy(action);
    try {
      await api.post(`/api/clients/${c.id}/${action}`, body);
      void qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      toast.error(`${c.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card flex items-center gap-3 p-3">
      <div className={clsx('grid size-9 shrink-0 place-items-center rounded-lg', c.online ? 'bg-ok/12 text-ok' : 'bg-bad/12 text-bad')}>
        {c.online ? <Download className="size-4" /> : <CircleAlert className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a href={c.publicUrl} target="_blank" rel="noreferrer" className="truncate text-sm font-semibold hover:underline">
            {c.name}
          </a>
          <Badge tone={c.protocol === 'usenet' ? 'info' : 'neutral'}>{c.protocol}</Badge>
        </div>
        {c.online ? (
          <div className="flex items-center gap-3 text-xs tabular-nums text-muted">
            <span className="inline-flex items-center gap-1">
              <ArrowDown className="size-3 text-ok" />
              {speed(c.downloadSpeed)}
            </span>
            {c.protocol === 'torrent' && (
              <span className="inline-flex items-center gap-1">
                <ArrowUp className="size-3 text-info" />
                {speed(c.uploadSpeed)}
              </span>
            )}
            {c.paused && <span className="text-warn">paused</span>}
          </div>
        ) : (
          <div className="truncate text-xs text-bad" title={c.error}>
            {c.error || 'Offline'}
          </div>
        )}
      </div>
      {c.online && (
        <div className="flex items-center gap-1">
          {c.supportsAltSpeed && (
            <IconButton
              icon={Turtle}
              size="sm"
              label={c.altSpeed ? 'Alternative speed limits ON - click to disable' : 'Enable alternative (slow) speed limits'}
              variant={c.altSpeed ? 'success' : 'ghost'}
              loading={busy === 'altspeed'}
              onClick={() => void act('altspeed', { enabled: !c.altSpeed })}
            />
          )}
          <IconButton icon={Pause} size="sm" label="Pause all" loading={busy === 'pause-all'} onClick={() => void act('pause-all')} />
          <IconButton icon={Play} size="sm" label="Resume all" loading={busy === 'resume-all'} onClick={() => void act('resume-all')} />
        </div>
      )}
    </div>
  );
}

function DownloadRow({ d, isAdmin }: { d: DownloadView; isAdmin: boolean }) {
  const { title, subtitle } = downloadTitle(d);
  const st = STATE[d.state] || { label: d.state, tone: 'neutral' as Tone };
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const transferring = d.state === 'downloading' || d.state === 'metadata';

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const checks = [];
    if (d.arr && isAdmin) checks.push({ id: 'blocklist', label: `Blocklist this release and let ${d.arr.service[0].toUpperCase()}${d.arr.service.slice(1)} find another`, defaultChecked: isProblem(d) });
    if (isAdmin && d.controllable) checks.push({ id: 'files', label: 'Delete the downloaded files', defaultChecked: !d.done });
    const ok = await confirm({ title: 'Remove download?', message: <span className="break-all">{d.name}</span>, confirmLabel: 'Remove', danger: true, checks });
    if (!ok) return;
    if (d.arr && isAdmin && (ok.blocklist || !d.controllable)) {
      await run('remove', () => api.del(`/api/queue/${d.arr!.service}/${d.arr!.queueIds[0]}?blocklist=${!!ok.blocklist}&removeFromClient=true`));
    } else {
      await run('remove', () => api.del(`/api/downloads/${d.client}/${encodeURIComponent(d.id)}?deleteFiles=${!!ok.files}`));
    }
    toast.success('Removed', title);
  };

  return (
    <div className="flex gap-3.5 p-3.5 sm:p-4">
      <div className="w-11 shrink-0 sm:w-12">
        {d.media ? (
          <Poster src={d.media.poster} fallback={d.media.posterAlt} kind={d.media.kind} title={title} rounded="rounded-lg" compact />
        ) : (
          <div className="grid aspect-[2/3] place-items-center rounded-lg bg-inset ring-1 ring-line">
            {d.grab ? (() => {
              const Icon = KIND_ICON[d.grab.kind];
              return <Icon className="size-5 text-subtle" />;
            })() : <FileDown className="size-5 text-subtle" />}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" title={title}>
              {title}
            </div>
            <div className="truncate text-xs text-muted" title={d.name}>
              {subtitle ? `${subtitle} · ` : ''}
              {d.media ? d.name : d.category ? `Category: ${d.category}` : d.clientName}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {d.imported && <Badge tone="ok">In library</Badge>}
            <Badge tone={st.tone}>{st.label}</Badge>
            <Badge>{d.clientName}</Badge>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <Progress value={d.progress} tone={st.tone === 'bad' ? 'bad' : st.tone === 'warn' ? 'warn' : d.done ? 'ok' : 'accent'} active={transferring && d.downloadSpeed > 0} />
          <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(d.progress)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted">
          <span>
            {bytes(d.downloaded)} / {bytes(d.size)}
          </span>
          {transferring && (
            <>
              <span className="inline-flex items-center gap-1">
                <ArrowDown className="size-3 text-ok" />
                {speed(d.downloadSpeed)}
              </span>
              <span>ETA {duration(d.eta)}</span>
            </>
          )}
          {d.uploadSpeed > 0 && (
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="size-3 text-info" />
              {speed(d.uploadSpeed)}
            </span>
          )}
          {d.protocol === 'torrent' && d.ratio !== undefined && d.done && <span>Ratio {d.ratio.toFixed(2)}</span>}
          {d.protocol === 'torrent' && d.seeds !== undefined && !d.done && <span>{d.seeds} seeds</span>}
          {(d.completedAt || d.addedAt) && <span>{d.completedAt ? `Finished ${relative(d.completedAt)}` : `Added ${relative(d.addedAt)}`}</span>}
        </div>
        {(d.arr?.messages.length || d.message || d.grab?.error) && (
          <div className="mt-2 space-y-0.5 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
            {[...(d.arr?.messages || []), d.message, d.grab?.error].filter(Boolean).slice(0, 3).map((m, i) => (
              <div key={i} className="truncate" title={String(m)}>
                {m}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {d.media?.jellyfinUrl && (
            <a href={d.media.jellyfinUrl} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-black shadow hover:bg-white/90">
              <Play className="size-3.5 fill-current" /> {d.media.kind === 'album' || d.media.kind === 'artist' ? 'Listen' : 'Watch'} in Jellyfin
            </a>
          )}
          {d.grab?.listenUrl && (
            <a href={d.grab.listenUrl} target="_blank" rel="noreferrer">
              <Button size="xs" variant="success" icon={Headphones}>
                Listen in {d.grab.listenApp || 'app'}
              </Button>
            </a>
          )}
          {d.grab?.downloadUrl && (
            <a href={d.grab.downloadUrl} download>
              <Button size="xs" variant={d.grab.kind === 'files' ? 'primary' : 'secondary'} icon={FileDown}>
                Download to this device
              </Button>
            </a>
          )}
          {d.controllable && !d.inHistory && (
            d.paused ? (
              <Button size="xs" variant="ghost" icon={Play} loading={busy === 'resume'} onClick={() => void run('resume', () => api.post(`/api/downloads/${d.client}/${encodeURIComponent(d.id)}/resume`))}>
                Resume
              </Button>
            ) : (
              <Button size="xs" variant="ghost" icon={Pause} loading={busy === 'pause'} onClick={() => void run('pause', () => api.post(`/api/downloads/${d.client}/${encodeURIComponent(d.id)}/pause`))}>
                Pause
              </Button>
            )
          )}
          {(d.controllable || isAdmin) && (
            <Button size="xs" variant="ghost" icon={Trash} loading={busy === 'remove'} onClick={() => void remove()}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const GRAB_STATE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  downloading: { label: 'Downloading', tone: 'accent' },
  importing: { label: 'Importing', tone: 'info' },
  imported: { label: 'In library', tone: 'ok' },
  completed: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  removed: { label: 'Removed', tone: 'neutral' },
};

function GrabRow({ g, isAdmin }: { g: GrabView; isAdmin: boolean }) {
  const Icon = KIND_ICON[g.kind];
  const st = GRAB_STATE[g.status];
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast.success(msg);
      void qc.invalidateQueries({ queryKey: ['grabs'] });
      void qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className={clsx('grid size-10 shrink-0 place-items-center rounded-xl', g.kind === 'music' ? 'bg-ok/12 text-ok' : g.kind === 'audiobook' ? 'bg-info/12 text-info' : 'bg-fg/[0.06] text-muted')}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={g.title}>
            {g.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <Badge tone={st.tone}>{st.label}</Badge>
            {g.status === 'downloading' && g.progress !== undefined && <span className="tabular-nums">{pct(g.progress)}</span>}
            <span>{g.clientName}</span>
            {g.size ? <span>· {bytes(g.size)}</span> : null}
            <span>· {relative(g.addedAt)}</span>
            {g.destination && <span className="truncate">· {g.destination}</span>}
          </div>
          {g.error && <div className="mt-1 truncate text-xs text-warn" title={g.error}>{g.error}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        {g.listenUrl && (
          <a href={g.listenUrl} target="_blank" rel="noreferrer">
            <Button size="xs" variant="success" icon={Headphones}>
              Listen{g.listenApp ? ` in ${g.listenApp}` : ''}
            </Button>
          </a>
        )}
        {g.downloadUrl && (
          <a href={g.downloadUrl} download>
            <Button size="xs" variant={g.kind === 'files' ? 'primary' : 'secondary'} icon={FileDown}>
              Download
            </Button>
          </a>
        )}
        {g.status === 'completed' && g.kind === 'files' && isAdmin && AUDIO_HINT.test(g.title) && (
          <>
            <Button size="xs" variant="ghost" icon={Music} loading={busy === 'music'} onClick={() => void run('music', () => api.post(`/api/grabs/${g.id}/retry`, { kind: 'music' }), 'Moving to your music library')}>
              To music
            </Button>
            <Button size="xs" variant="ghost" icon={BookHeadphones} loading={busy === 'book'} onClick={() => void run('book', () => api.post(`/api/grabs/${g.id}/retry`, { kind: 'audiobook' }), 'Moving to your audiobooks')}>
              To audiobooks
            </Button>
          </>
        )}
        {g.status === 'failed' && (
          <Button size="xs" variant="ghost" icon={RefreshCw} loading={busy === 'retry'} onClick={() => void run('retry', () => api.post(`/api/grabs/${g.id}/retry`, {}))}>
            Retry
          </Button>
        )}
        <IconButton icon={Trash} size="sm" label="Remove from this list (keeps files)" loading={busy === 'del'} onClick={() => void run('del', () => api.del(`/api/grabs/${g.id}`))} />
      </div>
    </div>
  );
}

export function DownloadsPage() {
  const { data, isLoading, error } = useDownloads(true);
  const { data: grabs } = useGrabs();
  const { data: app } = useApp();
  const isAdmin = app?.user.role === 'admin';
  const [filter, setFilter] = useState<Filter>('active');
  const [text, setText] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const items = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (data?.items || []).filter((d) => {
      if (t && !d.name.toLowerCase().includes(t) && !d.media?.title.toLowerCase().includes(t)) return false;
      if (filter === 'active') return isActive(d) || isProblem(d);
      if (filter === 'done') return d.done;
      if (filter === 'problems') return isProblem(d);
      return true;
    });
  }, [data, filter, text]);

  const counts = useMemo(() => {
    const all = data?.items || [];
    return { active: all.filter((d) => isActive(d) || isProblem(d)).length, done: all.filter((d) => d.done).length, problems: all.filter(isProblem).length, all: all.length };
  }, [data]);

  const recentGrabs = (grabs || []).slice(0, 25);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Download}
        title="Downloads"
        subtitle={data ? `${speed(data.totals.downloadSpeed)} down · ${speed(data.totals.uploadSpeed)} up · ${data.totals.active} active` : 'Loading…'}
        actions={
          isAdmin && (
            <Button
              variant="secondary"
              icon={RefreshCw}
              onClick={async () => {
                for (const service of ['radarr', 'sonarr', 'lidarr', 'readarr']) {
                  if (app?.services[service]?.enabled) await api.post('/api/command', { service, name: 'RefreshMonitoredDownloads' }).catch(() => undefined);
                }
                void qc.invalidateQueries({ queryKey: ['downloads'] });
                toast.info('Asked the *arr apps to re-check their downloads');
              }}
            >
              Refresh
            </Button>
          )
        }
      />

      {data && data.clients.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.clients.map((c) => (
            <ClientCard key={c.id} c={c} />
          ))}
        </div>
      )}
      {data && !data.clients.length && (
        <div className="rounded-xl border border-line bg-inset/60 px-4 py-3 text-sm text-muted">
          No download client is connected to AIO Arr yet - add qBittorrent, SABnzbd or another client in Settings to see live speeds and control downloads here.
        </div>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'active', label: 'Active', count: counts.active },
              { value: 'done', label: 'Completed', count: counts.done },
              { value: 'problems', label: 'Problems', count: counts.problems },
              { value: 'all', label: 'All', count: counts.all },
            ]}
          />
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <input className="input pl-9" placeholder="Filter downloads…" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
        {data?.errors.length ? <ErrorNote className="mb-3">{data.errors.slice(0, 3).join(' · ')}</ErrorNote> : null}
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Download} title={filter === 'active' ? 'Nothing downloading' : 'Nothing here'}>
            {filter === 'active' ? 'Search for something and hit Download - it will show up here with live progress.' : 'Try another filter.'}
          </EmptyState>
        ) : (
          <div className="card divide-y divide-line">
            {items.map((d) => (
              <DownloadRow key={d.key} d={d} isAdmin={!!isAdmin} />
            ))}
          </div>
        )}
      </section>

      {recentGrabs.length > 0 && (
        <section>
          <SectionHeader
            title="Direct downloads"
            icon={ExternalLink}
            subtitle="Grabbed from your indexers: music & audiobooks are moved into your listening apps, everything else is ready to download to this device"
            action={
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  await api.post('/api/grabs/clear');
                  void qc.invalidateQueries({ queryKey: ['grabs'] });
                }}
              >
                Clear finished
              </Button>
            }
          />
          <div className="card divide-y divide-line">
            {recentGrabs.map((g) => (
              <GrabRow key={g.id} g={g} isAdmin={!!isAdmin} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
