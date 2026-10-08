import clsx from 'clsx';
import { ArrowDownUp, BookOpen, Check, ChevronDown, Disc3, Download, FileDown, Film, Globe, Layers, LayoutGrid, List, Mic, Search, Tv } from 'lucide-react';
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../lib/api';
import { age, bytes } from '../lib/format';
import { CONTENT_META, CONTENT_ORDER, GRAB_KIND_META } from '../lib/content';
import { grabIndexerRelease, useApp, useArtwork, useIndexerSearch, useSearch, type ArtworkRequest, type SearchResponse, type SearchSection } from '../lib/queries';
import { useRouter } from '../lib/router';
import type { AppInfo, ArtworkMatch, ContentType, GrabKind, ParsedTitle, ReleaseView } from '../lib/types';
import { CategoryChips, useCategorySelection } from '../components/categories';
import { MediaCard, MediaGrid, Poster, PosterBadge, Row, useDownloadIndex } from '../components/media';
import { Modal, useToast } from '../components/overlay';
import { Badge, Button, Dropdown, EmptyState, ErrorNote, MenuItem, MenuLabel, Skeleton, Tabs } from '../components/ui';

type View = 'titles' | 'releases';

/** With several categories on screen each one is a single scrolling row of this many titles. */
const ROW_LIMIT = 20;
/** ... and offers "See all" (that category as a grid) when it has more than fit on screen. */
const SEE_ALL_FROM = 7;

/** Categories whose *arr app answers with posters you can add. */
const LIBRARY_SECTIONS: Partial<Record<ContentType, { key: keyof SearchResponse; title: string; icon: ComponentType<{ className?: string }> }[]>> = {
  movies: [{ key: 'movies', title: 'Movies', icon: Film }],
  tv: [{ key: 'series', title: 'TV shows', icon: Tv }],
  music: [
    { key: 'artists', title: 'Artists', icon: Mic },
    { key: 'albums', title: 'Albums', icon: Disc3 },
  ],
  ebooks: [{ key: 'books', title: 'Books', icon: BookOpen }],
};

const ART_SOURCE: Record<string, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
  tmdb: 'TMDB',
  itunes: 'Apple Books & Music',
  openlibrary: 'Open Library',
  googlebooks: 'Google Books',
  steam: 'Steam',
  wikipedia: 'Wikipedia',
};

/* ------------------------------ release groups ------------------------------ */

/** All releases of one title ("Hades II" on three indexers, every episode of a show ...). */
interface Group {
  key: string;
  category: ContentType;
  title: string;
  year?: number;
  artist?: string;
  /** platforms, versions, episodes ... */
  details: string[];
  ids?: ParsedTitle['ids'];
  /** cover supplied by an indexer */
  poster?: string;
  releases: ReleaseView[];
}

function groupReleases(list: ReleaseView[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of list) {
    const category = r.category || 'other';
    const p = r.parsed;
    const key = p?.key || `${category}:${r.title.toLowerCase()}`;
    let g = map.get(key);
    if (!g) {
      g = { key, category, title: p?.title || r.title, year: p?.year, artist: p?.artist, details: [], ids: p?.ids, releases: [] };
      map.set(key, g);
    }
    g.releases.push(r);
    if (p?.detail && !g.details.includes(p.detail)) g.details.push(p.detail);
    if (!g.poster && r.poster) g.poster = r.poster;
    if (!g.year && p?.year) g.year = p.year;
    if (p?.ids) g.ids = { ...p.ids, ...g.ids };
  }
  // releases arrive best first, so groups are ranked by their best release
  return [...map.values()];
}

const artRequest = (g: Group): ArtworkRequest => ({ key: g.key, category: g.category, title: g.title, year: g.year, artist: g.artist, ids: g.ids });

const groupKeyOf = (r: ReleaseView) => r.parsed?.key || `${r.category || 'other'}:${r.title.toLowerCase()}`;

/* ------------------------------ grabbing ------------------------------ */

/** What "Download" does with a release: into a library, or files for this device. */
function defaultKind(r: ReleaseView, app?: AppInfo): GrabKind {
  const k = r.kind || 'files';
  if (k === 'files' || !app) return k;
  return app.libraries.includes(k) && !app.keepAsFiles.includes(GRAB_KIND_META[k].content) ? k : 'files';
}

function useGrabber(app?: AppInfo) {
  const [sent, setSent] = useState<Record<string, 'busy' | 'done'>>({});
  const toast = useToast();
  const qc = useQueryClient();
  const { navigate } = useRouter();
  const grab = async (r: ReleaseView, kind?: GrabKind) => {
    const key = `${r.indexerId}:${r.guid}`;
    setSent((s) => ({ ...s, [key]: 'busy' }));
    try {
      const g = await grabIndexerRelease(r.guid, r.indexerId, kind);
      setSent((s) => ({ ...s, [key]: 'done' }));
      const effective = kind || defaultKind({ ...r, kind: g.kind }, app);
      const where = effective === 'files' ? 'ready to download from Downloads when finished' : `${GRAB_KIND_META[effective].hint.toLowerCase()} when finished`;
      toast.success(`Downloading with ${g.clientName}`, `${r.title} - ${where}.`, { label: 'View downloads', onClick: () => navigate('/downloads') });
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
  return { sent, grab };
}

type Grabber = ReturnType<typeof useGrabber>;

function GrabButton({ r, grabber, app }: { r: ReleaseView; grabber: Grabber; app?: AppInfo }) {
  const state = grabber.sent[`${r.indexerId}:${r.guid}`];
  if (state === 'done') {
    return (
      <Badge tone="ok" icon={Check} className="h-8 px-3 text-xs">
        Sent
      </Badge>
    );
  }
  const def = defaultKind(r, app);
  const pick = (k: GrabKind, close: () => void) => {
    close();
    void grabber.grab(r, k);
  };
  return (
    <div className="flex shrink-0 items-center">
      <Button
        size="sm"
        variant="primary"
        icon={Download}
        loading={state === 'busy'}
        onClick={() => void grabber.grab(r)}
        className="rounded-r-none"
        title={def === 'files' ? 'Download it, then save the files to this device from Downloads' : GRAB_KIND_META[def].hint}
      >
        Download
      </Button>
      <Dropdown
        button={({ toggle, open }) => (
          <button
            type="button"
            disabled={state === 'busy'}
            onClick={toggle}
            aria-expanded={open}
            aria-label="Download as…"
            className="grid h-8 w-7 place-items-center rounded-r-lg border-l border-white/20 bg-accent text-accent-fg hover:bg-accent-strong disabled:opacity-50"
          >
            <ChevronDown className="size-3.5" />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLabel>Download as</MenuLabel>
            {(app?.libraries || []).map((k) => (
              <MenuItem key={k} icon={GRAB_KIND_META[k].icon} label={`${GRAB_KIND_META[k].label} library`} hint={GRAB_KIND_META[k].hint} checked={def === k} onClick={() => pick(k, close)} />
            ))}
            <MenuItem icon={FileDown} label="Files for this device" hint="Save them from Downloads when finished" checked={def === 'files'} onClick={() => pick('files', close)} />
          </>
        )}
      </Dropdown>
    </div>
  );
}

function ReleaseRow({ r, grabber, app, art, thumb }: { r: ReleaseView; grabber: Grabber; app?: AppInfo; art?: ArtworkMatch; thumb?: boolean }) {
  const cat = r.category || 'other';
  return (
    <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center">
      {thumb && (
        <Poster
          src={art?.image || r.poster}
          fallback={art?.imageAlt || r.poster}
          kind={cat}
          title={r.parsed?.title || r.title}
          className="hidden w-10 shrink-0 sm:block"
          rounded="rounded-md"
          compact
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={r.title}>
          {r.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Badge>{CONTENT_META[cat].label}</Badge>
          {r.parsed?.detail && <span className="font-medium text-fg/80">{r.parsed.detail}</span>}
          <span>{bytes(r.size)}</span>
          <span>· {age(r.ageHours)}</span>
          {r.protocol === 'torrent' ? (
            <span className={clsx(r.seeders && r.seeders > 10 ? 'text-ok' : r.seeders ? 'text-warn' : 'text-bad')}>· {r.seeders ?? 0} seeders</span>
          ) : (
            <span>· usenet{r.grabs ? ` · ${r.grabs} grabs` : ''}</span>
          )}
          <span className="truncate">· {r.indexer}</span>
        </div>
      </div>
      <div className="self-end sm:self-auto">
        <GrabButton r={r} grabber={grabber} app={app} />
      </div>
    </div>
  );
}

/* ------------------------------ titles view ------------------------------ */

function GridSkeleton({ n = 6, square, row }: { n?: number; square?: boolean; row?: boolean }) {
  return (
    <div className={row ? 'flex gap-4 overflow-hidden' : 'grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={row ? 'w-32 shrink-0 sm:w-36' : undefined}>
          <Skeleton className={square ? 'aspect-square' : 'aspect-[2/3]'} />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

const SeeAll = ({ n, onClick, label }: { n: number; onClick: () => void; label?: string }) => (
  <button type="button" onClick={onClick} className="shrink-0 text-xs font-semibold text-accent hover:underline">
    {label || `See all ${n}`}
  </button>
);

function SectionTitle({ icon: Icon, title, count, note, action }: { icon: ComponentType<{ className?: string }>; title: string; count?: number; note?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
        <Icon className="size-4 shrink-0 text-accent" /> {title}
        {count !== undefined && <span className="text-xs font-normal text-subtle">{count}</span>}
        {note && <span className="hidden truncate text-xs font-normal text-subtle sm:inline">· {note}</span>}
      </h2>
      {action}
    </div>
  );
}

function LibrarySection({
  title,
  icon,
  section,
  loading,
  row,
  square,
  onMore,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  section?: SearchSection;
  loading: boolean;
  /** one scrolling row (several categories on screen) */
  row: boolean;
  square?: boolean;
  onMore: () => void;
}) {
  const dlIndex = useDownloadIndex();
  const items = section?.items || [];
  if (!loading && !items.length && !section?.error) return null;
  return (
    <section>
      <SectionTitle icon={icon} title={title} count={loading ? undefined : items.length} action={row && items.length >= SEE_ALL_FROM ? <SeeAll n={items.length} onClick={onMore} /> : undefined} />
      {loading ? (
        <GridSkeleton n={row ? 8 : 6} row={row} square={square} />
      ) : section?.error ? (
        <ErrorNote>{section.error}</ErrorNote>
      ) : row ? (
        <Row>
          {items.slice(0, ROW_LIMIT).map((it) => (
            <div key={it.key} className="w-32 shrink-0 sm:w-36">
              <MediaCard item={it} dl={it.id ? dlIndex.get(`${it.service}:${it.id}`) : undefined} />
            </div>
          ))}
        </Row>
      ) : (
        <MediaGrid items={items} dlIndex={dlIndex} />
      )}
    </section>
  );
}

function TitleCard({ g, art, onOpen, className }: { g: Group; art?: ArtworkMatch; onOpen: () => void; className?: string }) {
  const detail = g.details.length === 1 ? g.details[0] : g.details.length > 1 ? `${g.details[0]} +${g.details.length - 1}` : undefined;
  return (
    <button type="button" onClick={onOpen} className={clsx('group fade-up block min-w-0 text-left', className)} aria-label={`${g.title}: ${g.releases.length} downloads`}>
      <div className="relative">
        <Poster
          src={art?.image || g.poster}
          fallback={art?.imageAlt || g.poster}
          kind={g.category}
          title={g.title}
          className="transition-transform duration-300 group-hover:scale-[1.02] group-hover:shadow-xl group-hover:shadow-black/30"
        />
        {g.releases.length > 1 && (
          <div className="absolute top-2 left-2" title={`${g.releases.length} downloads to choose from`}>
            <PosterBadge icon={Layers}>{g.releases.length} versions</PosterBadge>
          </div>
        )}
        {detail && (
          <div className="absolute top-2 right-2 max-w-[65%] truncate">
            <PosterBadge>{detail}</PosterBadge>
          </div>
        )}
        <div className="absolute inset-0 flex items-end justify-center rounded-xl bg-gradient-to-t from-black/75 via-black/10 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg shadow-lg">
            <Download className="size-3.5" /> Choose a download
          </span>
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <div className="truncate text-[13px] font-semibold" title={g.title}>
          {g.title}
        </div>
        <div className="truncate text-xs text-muted">{[g.year, g.artist].filter(Boolean).join(' · ') || CONTENT_META[g.category].label}</div>
      </div>
    </button>
  );
}

function GroupSection({
  category,
  groups,
  shown,
  row,
  art,
  loading,
  onOpen,
  onMore,
}: {
  category: ContentType;
  groups: Group[];
  shown: number;
  /** one scrolling row (several categories on screen) */
  row: boolean;
  art: Record<string, ArtworkMatch>;
  loading: boolean;
  onOpen: (g: Group) => void;
  onMore: () => void;
}) {
  const m = CONTENT_META[category];
  if (!loading && !groups.length) return null;
  const more = row ? groups.length >= SEE_ALL_FROM : groups.length > shown;
  return (
    <section>
      <SectionTitle
        icon={m.icon}
        title={m.label}
        count={loading ? undefined : groups.length}
        note="from your indexers"
        action={more ? <SeeAll n={groups.length} onClick={onMore} label={row ? undefined : 'Show more'} /> : undefined}
      />
      {loading ? (
        <GridSkeleton n={row ? 8 : 6} row={row} square={m.shape === 'square'} />
      ) : row ? (
        <Row>
          {groups.slice(0, shown).map((g) => (
            <TitleCard key={g.key} g={g} art={art[g.key]} onOpen={() => onOpen(g)} className="w-32 shrink-0 sm:w-36" />
          ))}
        </Row>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          {groups.slice(0, shown).map((g) => (
            <TitleCard key={g.key} g={g} art={art[g.key]} onOpen={() => onOpen(g)} />
          ))}
        </div>
      )}
    </section>
  );
}

function GroupModal({ g, art, grabber, app, onClose }: { g: Group; art?: ArtworkMatch; grabber: Grabber; app?: AppInfo; onClose: () => void }) {
  const m = CONTENT_META[g.category];
  return (
    <Modal open onClose={onClose} size="lg" title={g.title}>
      <div className="flex gap-4">
        <Poster src={art?.image || g.poster} fallback={art?.imageAlt || g.poster} kind={g.category} title={g.title} className="w-24 shrink-0 shadow-lg sm:w-28" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent" icon={m.icon}>
              {m.label}
            </Badge>
            {g.year && <Badge>{g.year}</Badge>}
            {g.details.slice(0, 8).map((d) => (
              <Badge key={d}>{d}</Badge>
            ))}
            {g.details.length > 8 && <Badge>+{g.details.length - 8}</Badge>}
          </div>
          {g.artist && <div className="mt-2 text-sm font-medium text-muted">{g.artist}</div>}
          {art?.overview && <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted">{art.overview}</p>}
          <div className="mt-2 text-xs text-subtle">
            {g.releases.length} {g.releases.length === 1 ? 'download' : 'downloads'} found on your indexers
            {art?.source && ART_SOURCE[art.source] ? ` · picture from ${ART_SOURCE[art.source]}` : ''}
          </div>
        </div>
      </div>
      <div className="card mt-5 divide-y divide-line">
        {g.releases.map((r) => (
          <ReleaseRow key={`${r.indexerId}:${r.guid}`} r={r} grabber={grabber} app={app} />
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------ releases view ------------------------------ */

function ReleasesView({ releases, loading, error, q, grabber, app }: { releases: ReleaseView[]; loading: boolean; error: unknown; q: string; grabber: Grabber; app?: AppInfo }) {
  const [sort, setSort] = useState<'seeders' | 'size' | 'age'>('seeders');
  const [limit, setLimit] = useState(50);
  const sorted = useMemo(() => {
    const list = [...releases];
    if (sort === 'size') list.sort((a, b) => b.size - a.size);
    else if (sort === 'age') list.sort((a, b) => (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9));
    return list;
  }, [releases, sort]);
  const shown = useMemo(() => sorted.slice(0, limit), [sorted, limit]);
  // one picture per title
  const requests = useMemo(() => {
    const seen = new Map<string, ArtworkRequest>();
    for (const g of groupReleases(shown)) if (!seen.has(g.key)) seen.set(g.key, artRequest(g));
    return [...seen.values()];
  }, [shown]);
  const art = useArtwork(requests);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorNote>{errorMessage(error)}</ErrorNote>;
  if (!releases.length) return <div className="rounded-xl border border-dashed border-line py-10 text-center text-sm text-muted">No downloads found for “{q}” in these categories.</div>;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {releases.length} {releases.length === 1 ? 'download' : 'downloads'} from your indexers
        </div>
        <button
          type="button"
          onClick={() => setSort((s) => (s === 'seeders' ? 'size' : s === 'size' ? 'age' : 'seeders'))}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-muted hover:text-fg"
        >
          <ArrowDownUp className="size-3.5" /> {sort === 'seeders' ? 'Most seeded' : sort === 'size' ? 'Largest' : 'Newest'}
        </button>
      </div>
      <div className="card divide-y divide-line">
        {shown.map((r) => (
          <ReleaseRow key={`${r.indexerId}:${r.guid}`} r={r} grabber={grabber} app={app} art={art[groupKeyOf(r)]} thumb />
        ))}
      </div>
      {sorted.length > limit && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 50)}>
            Show more ({sorted.length - limit} left)
          </Button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ page ------------------------------ */

export function SearchPage() {
  const { search, navigate } = useRouter();
  const q = (search.get('q') || '').trim();
  const view: View = search.get('view') === 'releases' ? 'releases' : 'titles';
  const { data: app } = useApp();
  const sel = useCategorySelection();
  const hasIndexer = !!app?.features.indexerSearch;

  const libraryCats = sel.cats.filter((c) => LIBRARY_SECTIONS[c] && sel.usable.find((u) => u.id === c)?.library);
  // everything else is shown as titles found on your indexers
  const groupCats = hasIndexer ? sel.cats.filter((c) => !libraryCats.includes(c)) : [];
  const lib = useSearch(q, libraryCats, libraryCats.length > 0);
  const idx = useIndexerSearch(q, sel.cats, hasIndexer && (view === 'releases' || groupCats.length > 0));
  const grabber = useGrabber(app);
  const [open, setOpen] = useState<Group | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<ContentType, number>>>({});

  const order = CONTENT_ORDER.filter((c) => sel.cats.includes(c));
  const groups = useMemo(() => groupReleases(idx.data || []), [idx.data]);
  const byCat = useMemo(() => {
    const m = new Map<ContentType, Group[]>();
    for (const g of groups) if (groupCats.includes(g.category)) m.set(g.category, [...(m.get(g.category) || []), g]);
    return m;
  }, [groups, groupCats.join(',')]);
  const sections = order.filter((c) => libraryCats.includes(c) || groupCats.includes(c));
  const single = sections.length === 1;
  const shownFor = (c: ContentType) => (single ? (expanded[c] ?? 24) : ROW_LIMIT);

  // pictures for the titles on screen
  const visible = useMemo(() => (view === 'titles' ? groupCats.flatMap((c) => (byCat.get(c) || []).slice(0, shownFor(c))) : []), [view, byCat, expanded, single]);
  const art = useArtwork(useMemo(() => visible.map(artRequest), [visible]));

  const setView = (v: View) => {
    const s = new URLSearchParams(search);
    if (v === 'titles') s.delete('view');
    else s.set('view', v);
    navigate(`/search?${s}`, { replace: true });
  };

  const counts = useMemo(() => {
    const c: Partial<Record<ContentType, number>> = {};
    if (view === 'releases') {
      for (const r of idx.data || []) c[r.category || 'other'] = (c[r.category || 'other'] || 0) + 1;
    } else {
      for (const cat of libraryCats) {
        if (lib.data) c[cat] = (LIBRARY_SECTIONS[cat] || []).reduce((n, s) => n + (lib.data?.[s.key]?.items.length || 0), 0);
      }
      for (const cat of groupCats) if (idx.data) c[cat] = byCat.get(cat)?.length || 0;
    }
    return c;
  }, [view, idx.data, lib.data, byCat, libraryCats.join(','), groupCats.join(',')]);

  if (!q) {
    return (
      <div className="space-y-6">
        <CategoryChips sel={sel} />
        <EmptyState icon={Search} title="Search everything">
          Type in the search bar above. Pick the categories to search in with the chips - movies and shows come from Radarr and Sonarr, everything else (games, comics, books, apps…) straight from your indexers, with pictures.
        </EmptyState>
      </div>
    );
  }

  const libLoading = lib.isLoading;
  const idxLoading = idx.isLoading;
  const nothing =
    !!app &&
    !libLoading &&
    !idxLoading &&
    sections.every((c) => (libraryCats.includes(c) ? !(LIBRARY_SECTIONS[c] || []).some((s) => lib.data?.[s.key]?.items.length || lib.data?.[s.key]?.error) : !byCat.get(c)?.length));

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight sm:text-2xl">
            Results for <span className="text-accent">“{q}”</span>
          </h1>
          {hasIndexer && (
            <Tabs
              value={view}
              onChange={setView}
              items={[
                { value: 'titles', label: 'Titles', icon: LayoutGrid },
                { value: 'releases', label: 'All downloads', icon: List, count: idx.data?.length },
              ]}
            />
          )}
        </div>
        <CategoryChips sel={sel} counts={counts} />
      </div>

      {lib.error && <ErrorNote>{errorMessage(lib.error)}</ErrorNote>}
      {view === 'titles' && idx.error && groupCats.length > 0 && <ErrorNote>Indexers: {errorMessage(idx.error)}</ErrorNote>}

      {!app ? (
        <GridSkeleton n={6} row />
      ) : view === 'releases' ? (
        <ReleasesView releases={idx.data || []} loading={idxLoading} error={idx.error} q={q} grabber={grabber} app={app} />
      ) : (
        <>
          {sections.map((c) =>
            libraryCats.includes(c) ? (
              (LIBRARY_SECTIONS[c] || []).map((s) => (
                <LibrarySection
                  key={s.key}
                  title={s.title}
                  icon={s.icon}
                  section={s.key === 'albums' && lib.data?.albums?.error && lib.data.albums.error === lib.data.artists?.error ? { items: [] } : lib.data?.[s.key]}
                  loading={libLoading}
                  row={!single}
                  square={c === 'music'}
                  onMore={() => sel.only(c)}
                />
              ))
            ) : (
              <GroupSection
                key={c}
                category={c}
                groups={byCat.get(c) || []}
                shown={shownFor(c)}
                row={!single}
                art={art}
                loading={idxLoading}
                onOpen={setOpen}
                onMore={() => (single ? setExpanded((e) => ({ ...e, [c]: shownFor(c) + 24 })) : sel.only(c))}
              />
            ),
          )}
          {nothing && (
            <EmptyState icon={Search} title="Nothing found">
              Nothing matched “{q}” in {sel.allMode ? 'any category' : sel.cats.map((c) => CONTENT_META[c].label.toLowerCase()).join(', ')}.
              {!sel.allMode && (
                <>
                  {' '}
                  <button type="button" onClick={sel.all} className="font-semibold text-accent hover:underline">
                    Search everything
                  </button>
                </>
              )}
            </EmptyState>
          )}
          {!hasIndexer && sel.cats.some((c) => !LIBRARY_SECTIONS[c]) && (
            <p className="flex items-center gap-1.5 text-xs text-subtle">
              <Globe className="size-3.5" /> Connect Prowlarr in Settings to also search games, comics, apps and everything else on your indexers.
            </p>
          )}
        </>
      )}
      {open && <GroupModal g={open} art={art[open.key]} grabber={grabber} app={app} onClose={() => setOpen(null)} />}
    </div>
  );
}
