import clsx from 'clsx';
import { BookOpen, Film, LayoutGrid, List, Mic, Play, Plus, Search, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { errorMessage } from '../lib/api';
import { bytes, shortDate } from '../lib/format';
import { useLibrary } from '../lib/queries';
import { Link } from '../lib/router';
import type { MediaItem, MediaKind } from '../lib/types';
import { MediaGrid, Poster, mediaStatus, useDownloadIndex, useMedia, type DlInfo } from '../components/media';
import { Badge, Button, EmptyState, ErrorNote, PageHeader, Select, Skeleton, Tabs } from '../components/ui';

type Filter = 'all' | 'available' | 'wanted' | 'downloading' | 'unmonitored';
type Sort = 'title' | 'added' | 'year' | 'size' | 'rating';

const META: Record<'movie' | 'series' | 'artist' | 'book', { title: string; icon: ComponentType<{ className?: string }>; noun: string }> = {
  movie: { title: 'Movies', icon: Film, noun: 'movie' },
  series: { title: 'TV Shows', icon: Tv, noun: 'show' },
  artist: { title: 'Music', icon: Mic, noun: 'artist' },
  book: { title: 'Books', icon: BookOpen, noun: 'book' },
};

function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, n);
      } catch {
        /* ignore */
      }
    },
  ];
}

function TableView({ items, dlIndex }: { items: MediaItem[]; dlIndex: Map<string, DlInfo> }) {
  const { open } = useMedia();
  return (
    <div className="card overflow-hidden">
      {items.map((it) => {
        const dl = it.id ? dlIndex.get(`${it.service}:${it.id}`) : undefined;
        const st = mediaStatus(it, dl);
        return (
          <div key={it.key} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0 hover:bg-card-hover">
            <button type="button" onClick={() => open(it)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <Poster src={it.poster} fallback={it.posterAlt} kind={it.kind} title={it.title} className="w-9 shrink-0" rounded="rounded-md" compact />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{it.title}</div>
                <div className="truncate text-xs text-muted">{[it.year, it.subtitle].filter(Boolean).join(' · ')}</div>
              </div>
            </button>
            <div className="hidden w-28 md:block">{st && <Badge tone={st.tone} icon={st.icon}>{st.label}</Badge>}</div>
            <div className="hidden w-20 text-right text-xs tabular-nums text-muted lg:block">{it.sizeOnDisk ? bytes(it.sizeOnDisk) : '—'}</div>
            <div className="hidden w-24 text-right text-xs text-muted xl:block">{it.added ? shortDate(it.added) : ''}</div>
            <div className="w-9 text-right">
              {it.jellyfin && (
                <a href={it.jellyfin.url} target="_blank" rel="noreferrer" className="inline-grid size-8 place-items-center rounded-lg text-ok hover:bg-ok/10" title="Open in Jellyfin">
                  <Play className="size-4 fill-current" />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LibraryPage({ kind }: { kind: 'movie' | 'series' | 'artist' | 'book' }) {
  const meta = META[kind];
  const { data, isLoading, error } = useLibrary(kind as MediaKind);
  const dlIndex = useDownloadIndex();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = usePref<Sort>(`aio-sort-${kind}`, 'title');
  const [view, setView] = usePref<'grid' | 'list'>(`aio-view-${kind}`, 'grid');
  const [limit, setLimit] = useState(120);
  const sentinel = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const t = text.trim().toLowerCase();
    let list = (data || []).filter((i) => !t || i.title.toLowerCase().includes(t) || i.subtitle?.toLowerCase().includes(t));
    list = list.filter((i) => {
      const dl = i.id ? dlIndex.get(`${i.service}:${i.id}`) : undefined;
      switch (filter) {
        case 'available':
          return i.availability === 'available';
        case 'wanted':
          return (i.availability === 'missing' || i.availability === 'partial') && i.monitored !== false;
        case 'downloading':
          return !!dl;
        case 'unmonitored':
          return i.monitored === false;
        default:
          return true;
      }
    });
    const by = (a: MediaItem, b: MediaItem) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title);
    switch (sort) {
      case 'added':
        return [...list].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
      case 'year':
        return [...list].sort((a, b) => (b.year || 0) - (a.year || 0) || by(a, b));
      case 'size':
        return [...list].sort((a, b) => (b.sizeOnDisk || 0) - (a.sizeOnDisk || 0));
      case 'rating':
        return [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0));
      default:
        return [...list].sort(by);
    }
  }, [data, text, filter, sort, dlIndex]);

  useEffect(() => setLimit(120), [text, filter, sort]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setLimit((l) => l + 120);
    }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length]);

  const counts = useMemo(() => {
    const all = data || [];
    return {
      available: all.filter((i) => i.availability === 'available').length,
      wanted: all.filter((i) => (i.availability === 'missing' || i.availability === 'partial') && i.monitored !== false).length,
      downloading: all.filter((i) => i.id && dlIndex.has(`${i.service}:${i.id}`)).length,
    };
  }, [data, dlIndex]);

  const totalSize = useMemo(() => (data || []).reduce((n, i) => n + (i.sizeOnDisk || 0), 0), [data]);

  return (
    <div>
      <PageHeader
        icon={meta.icon}
        title={meta.title}
        subtitle={data ? `${data.length.toLocaleString()} ${meta.noun}s · ${bytes(totalSize)} on disk` : 'Loading…'}
        actions={
          <Link to="/search">
            <Button variant="primary" icon={Plus}>
              Add {meta.noun}
            </Button>
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <input className="input pl-9" placeholder={`Filter ${meta.title.toLowerCase()}…`} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Tabs
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All' },
            { value: 'available', label: 'Available', count: counts.available },
            { value: 'wanted', label: 'Wanted', count: counts.wanted },
            { value: 'downloading', label: 'Downloading', count: counts.downloading },
            { value: 'unmonitored', label: 'Unmonitored' },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="!h-10 w-36" aria-label="Sort">
            <option value="title">Title</option>
            <option value="added">Recently added</option>
            <option value="year">Year</option>
            <option value="size">Size</option>
            <option value="rating">Rating</option>
          </Select>
          <div className="flex rounded-xl border border-line bg-inset p-1">
            {(['grid', 'list'] as const).map((v) => {
              const Icon = v === 'grid' ? LayoutGrid : List;
              return (
                <button key={v} type="button" onClick={() => setView(v)} className={clsx('grid size-8 place-items-center rounded-lg', view === v ? 'bg-card text-fg shadow-sm ring-1 ring-line' : 'text-subtle hover:text-fg')} aria-label={`${v} view`}>
                  <Icon className="size-4" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
      {isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i}>
              <Skeleton className={kind === 'artist' ? 'aspect-square' : 'aspect-[2/3]'} />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </div>
          ))}
        </div>
      )}
      {data && !items.length && (
        <EmptyState icon={meta.icon} title={data.length ? 'Nothing matches these filters' : `No ${meta.noun}s yet`}>
          {data.length ? 'Try a different filter.' : 'Use the search bar to find something and press Download.'}
        </EmptyState>
      )}
      {items.length > 0 && (view === 'grid' ? <MediaGrid items={items.slice(0, limit)} dlIndex={dlIndex} /> : <TableView items={items.slice(0, limit)} dlIndex={dlIndex} />)}
      {items.length > limit && <div ref={sentinel} className="h-10" />}
    </div>
  );
}
