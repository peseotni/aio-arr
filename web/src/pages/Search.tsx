import clsx from 'clsx';
import { AppWindow, ArrowDownUp, BookHeadphones, BookOpen, Check, ChevronDown, Disc3, Download, Film, Globe, Headphones, LayoutGrid, Mic, Music, Search, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../lib/api';
import { age, bytes } from '../lib/format';
import { grabIndexerRelease, useApp, useIndexerCategories, useIndexerSearch, useSearch, type SearchSection } from '../lib/queries';
import { useRouter } from '../lib/router';
import type { GrabKind, ReleaseView } from '../lib/types';
import { MediaGrid, useDownloadIndex } from '../components/media';
import { useToast } from '../components/overlay';
import { Badge, Button, EmptyState, ErrorNote, Skeleton, Tabs } from '../components/ui';

type Tab = 'all' | 'movies' | 'series' | 'music' | 'books' | 'indexers';

const KIND_META: Record<GrabKind, { label: string; icon: ComponentType<{ className?: string }>; tone: 'ok' | 'info' | 'neutral'; hint: string }> = {
  music: { label: 'Music', icon: Music, tone: 'ok', hint: 'Added to your music library' },
  audiobook: { label: 'Audiobook', icon: BookHeadphones, tone: 'info', hint: 'Added to your audiobook library' },
  files: { label: 'File', icon: AppWindow, tone: 'neutral', hint: 'Download to this computer from Files' },
};

function GridSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[2/3]" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  section,
  loading,
  limit,
  onMore,
  showKind,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  section?: SearchSection;
  loading: boolean;
  limit?: number;
  onMore?: () => void;
  showKind?: boolean;
}) {
  const dlIndex = useDownloadIndex();
  if (!loading && !section) return null;
  const items = section?.items || [];
  if (!loading && !items.length && !section?.error) return null;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon className="size-4 text-accent" /> {title}
          {!loading && <span className="text-xs font-normal text-subtle">{items.length}</span>}
        </h2>
        {onMore && limit && items.length > limit && (
          <button type="button" onClick={onMore} className="text-xs font-semibold text-accent hover:underline">
            Show all {items.length}
          </button>
        )}
      </div>
      {loading ? <GridSkeleton n={limit ? Math.min(limit, 6) : 6} /> : section?.error ? <ErrorNote>{section.error}</ErrorNote> : <MediaGrid items={limit ? items.slice(0, limit) : items} dlIndex={dlIndex} showKind={showKind} />}
    </section>
  );
}

function KindMenu({ value, onPick, disabled }: { value: GrabKind; onPick: (k: GrabKind) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-7 place-items-center rounded-r-lg border-l border-white/20 bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
        aria-label="Download as…"
      >
        <ChevronDown className="size-3.5" />
      </button>
      {open && (
        <div className="fade-up absolute right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-elev p-1.5 shadow-2xl">
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Download as</div>
          {(Object.keys(KIND_META) as GrabKind[]).map((k) => {
            const m = KIND_META[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(k);
                }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-card-hover"
              >
                <m.icon className="mt-0.5 size-4 text-muted" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-muted">{m.hint}</span>
                </span>
                {k === value && <Check className="mt-0.5 size-4 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IndexerResults({ q, limit, onMore }: { q: string; limit?: number; onMore?: () => void }) {
  const [cat, setCat] = useState('all');
  const [sort, setSort] = useState<'seeders' | 'size' | 'age'>('seeders');
  const { data: cats } = useIndexerCategories();
  const { data, isLoading, error } = useIndexerSearch(q, cat, true);
  const [sent, setSent] = useState<Record<string, 'busy' | 'done'>>({});
  const toast = useToast();
  const qc = useQueryClient();
  const { navigate } = useRouter();

  const sorted = useMemo(() => {
    const list = [...(data || [])];
    if (sort === 'size') list.sort((a, b) => b.size - a.size);
    else if (sort === 'age') list.sort((a, b) => (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9));
    return list;
  }, [data, sort]);
  const shown = limit ? sorted.slice(0, limit) : sorted;

  const grab = async (r: ReleaseView, kind?: GrabKind) => {
    const key = `${r.indexerId}:${r.guid}`;
    setSent((s) => ({ ...s, [key]: 'busy' }));
    try {
      const g = await grabIndexerRelease(r.guid, r.indexerId, kind);
      setSent((s) => ({ ...s, [key]: 'done' }));
      const k = KIND_META[g.kind];
      toast.success(`Downloading with ${g.clientName}`, `${r.title} - ${k.hint.toLowerCase()} when finished.`, { label: 'View downloads', onClick: () => navigate('/downloads') });
      void qc.invalidateQueries({ queryKey: ['downloads'] });
      void qc.invalidateQueries({ queryKey: ['grabs'] });
    } catch (err) {
      setSent((s) => {
        const n = { ...s };
        delete n[key];
        return n;
      });
      toast.error('Could not start the download', errorMessage(err));
    }
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Globe className="size-4 text-accent" /> Everything else <span className="text-xs font-normal text-subtle">from your indexers {data ? `· ${data.length}` : ''}</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSort((s) => (s === 'seeders' ? 'size' : s === 'size' ? 'age' : 'seeders'))}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-muted hover:text-fg"
          >
            <ArrowDownUp className="size-3.5" /> {sort === 'seeders' ? 'Most seeded' : sort === 'size' ? 'Largest' : 'Newest'}
          </button>
        </div>
      </div>
      <div className="no-scrollbar mb-3 flex gap-1.5 overflow-x-auto">
        {(cats || [{ id: 'all', label: 'Everything' }]).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            className={clsx(
              'h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors',
              cat === c.id ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-fg',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : error ? (
        <ErrorNote>{errorMessage(error)}</ErrorNote>
      ) : !shown.length ? (
        <div className="rounded-xl border border-dashed border-line py-8 text-center text-sm text-muted">No indexer results for “{q}”.</div>
      ) : (
        <div className="card divide-y divide-line overflow-visible">
          {shown.map((r) => {
            const key = `${r.indexerId}:${r.guid}`;
            const kind = r.kind || 'files';
            const meta = KIND_META[kind];
            const state = sent[key];
            return (
              <div key={key} className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center">
                <div className={clsx('hidden size-10 shrink-0 place-items-center rounded-xl sm:grid', kind === 'music' ? 'bg-ok/12 text-ok' : kind === 'audiobook' ? 'bg-info/12 text-info' : 'bg-fg/[0.06] text-muted')}>
                  <meta.icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={r.title}>
                    {r.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {r.categories?.[0] && <span>{r.categories[0].name}</span>}
                    <span>· {bytes(r.size)}</span>
                    <span>· {age(r.ageHours)}</span>
                    {r.protocol === 'torrent' ? (
                      <span className={clsx(r.seeders && r.seeders > 10 ? 'text-ok' : r.seeders ? 'text-warn' : 'text-bad')}>· {r.seeders ?? 0} seeders</span>
                    ) : (
                      <span>· usenet{r.grabs ? ` · ${r.grabs} grabs` : ''}</span>
                    )}
                    <span className="truncate">· {r.indexer}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center self-end sm:self-auto">
                  {state === 'done' ? (
                    <Badge tone="ok" icon={Check} className="h-8 px-3 text-xs">
                      Sent
                    </Badge>
                  ) : (
                    <>
                      <Button size="sm" variant="primary" icon={Download} loading={state === 'busy'} onClick={() => void grab(r)} className="rounded-r-none" title={meta.hint}>
                        Download
                      </Button>
                      <KindMenu value={kind} disabled={state === 'busy'} onPick={(k) => void grab(r, k)} />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {limit && onMore && sorted.length > limit && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={onMore}>
            Show all {sorted.length} results
          </Button>
        </div>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
        <Headphones className="size-3.5" /> Music and audiobooks go straight into your listening apps. Apps, ebooks and other files appear under Files, ready to download to this computer.
      </p>
    </section>
  );
}

export function SearchPage() {
  const { search, navigate } = useRouter();
  const q = (search.get('q') || '').trim();
  const tab = (search.get('tab') as Tab) || 'all';
  const { data: app } = useApp();
  const svc = app?.services || {};
  const { data, isLoading, error } = useSearch(q);
  const setTab = (t: Tab) => navigate(`/search?q=${encodeURIComponent(q)}${t === 'all' ? '' : `&tab=${t}`}`, { replace: true });

  if (!q) {
    return (
      <EmptyState icon={Search} title="Search everything">
        Type in the search bar above to find movies, TV shows, music and books - or anything else your indexers have (apps, games, ebooks…).
      </EmptyState>
    );
  }

  const count = (s?: SearchSection) => s?.items.length ?? 0;
  const tabs: { value: Tab; label: string; icon: ComponentType<{ className?: string }>; count?: number; show: boolean }[] = [
    { value: 'all', label: 'All', icon: LayoutGrid, show: true },
    { value: 'movies', label: 'Movies', icon: Film, count: count(data?.movies), show: !!svc.radarr?.enabled },
    { value: 'series', label: 'TV', icon: Tv, count: count(data?.series), show: !!svc.sonarr?.enabled },
    { value: 'music', label: 'Music', icon: Disc3, count: count(data?.artists) + count(data?.albums), show: !!svc.lidarr?.enabled },
    { value: 'books', label: 'Books', icon: BookOpen, count: count(data?.books), show: !!svc.readarr?.enabled },
    { value: 'indexers', label: 'Indexers', icon: Globe, show: !!svc.prowlarr?.enabled },
  ];
  const visible = tabs.filter((t) => t.show);
  const all = tab === 'all';
  const nothing = !isLoading && data && !count(data.movies) && !count(data.series) && !count(data.artists) && !count(data.albums) && !count(data.books);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Results for <span className="text-accent">“{q}”</span>
        </h1>
        <Tabs value={tab} onChange={setTab} items={visible.map((t) => ({ value: t.value, label: t.label, icon: t.icon, count: isLoading ? undefined : t.count }))} />
      </div>
      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
      {(all || tab === 'movies') && <Section title="Movies" icon={Film} section={data?.movies} loading={isLoading && !!svc.radarr?.enabled} limit={all ? 12 : undefined} onMore={() => setTab('movies')} />}
      {(all || tab === 'series') && <Section title="TV shows" icon={Tv} section={data?.series} loading={isLoading && !!svc.sonarr?.enabled} limit={all ? 12 : undefined} onMore={() => setTab('series')} />}
      {(all || tab === 'music') && (
        <>
          <Section title="Artists" icon={Mic} section={data?.artists} loading={isLoading && !!svc.lidarr?.enabled} limit={all ? 6 : undefined} onMore={() => setTab('music')} />
          <Section title="Albums" icon={Disc3} section={data?.albums?.error && data.albums.error === data.artists?.error ? { items: [] } : data?.albums} loading={isLoading && !!svc.lidarr?.enabled} limit={all ? 6 : undefined} onMore={() => setTab('music')} />
        </>
      )}
      {(all || tab === 'books') && <Section title="Books" icon={BookOpen} section={data?.books} loading={isLoading && !!svc.readarr?.enabled} limit={all ? 12 : undefined} onMore={() => setTab('books')} />}
      {nothing && !svc.prowlarr?.enabled && (
        <EmptyState icon={Search} title="Nothing found">
          No movies, shows, music or books matched “{q}”.
        </EmptyState>
      )}
      {(all || tab === 'indexers') && svc.prowlarr?.enabled && <IndexerResults q={q} limit={all ? 8 : undefined} onMore={() => setTab('indexers')} />}
    </div>
  );
}
