import clsx from 'clsx';
import { BookOpen, Check, ChevronLeft, ChevronRight, CircleDashed, Clock, Disc3, Download, Film, Headphones, LoaderCircle, Mic, Play, Plus, Tv, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ContentType, DownloadView, MediaItem, MediaKind, PlayLink } from '../lib/types';
import { addMedia, canAdd, resolveMedia, useDownloads } from '../lib/queries';
import { CONTENT_META } from '../lib/content';
import { errorMessage } from '../lib/api';
import { useRouter } from '../lib/router';
import { useToast } from './overlay';
import { type Tone } from './ui';

export const KIND_ICON: Record<MediaKind, ComponentType<{ className?: string }>> = {
  movie: Film,
  series: Tv,
  artist: Mic,
  album: Disc3,
  book: BookOpen,
};

export const KIND_LABEL: Record<MediaKind, string> = { movie: 'Movie', series: 'TV show', artist: 'Artist', album: 'Album', book: 'Book' };

/* ------------------------------ play links ------------------------------ */

export const PLAY_ICON: Record<PlayLink['verb'], ComponentType<{ className?: string }>> = { Watch: Play, Listen: Headphones, Read: BookOpen };

/** "Watch in Jellyfin", "Read in Komga" */
export const playLabel = (play: PlayLink) => `${play.verb} in ${play.name}`;

type PosterKind = MediaKind | ContentType | 'episode' | 'file';

function posterLook(kind: PosterKind): { icon: ComponentType<{ className?: string }>; square: boolean } {
  if (kind in CONTENT_META) {
    const m = CONTENT_META[kind as ContentType];
    return { icon: m.icon, square: m.shape === 'square' };
  }
  if (kind === 'episode') return { icon: Tv, square: false };
  if (kind === 'file') return { icon: Download, square: false };
  return { icon: KIND_ICON[kind as MediaKind], square: kind === 'album' || kind === 'artist' };
}

/* ------------------------------ Poster ------------------------------ */

export function Poster({
  src,
  alt,
  fallback,
  kind,
  title,
  className,
  rounded = 'rounded-xl',
  compact,
}: {
  src?: string;
  alt?: string;
  fallback?: string;
  /** a library kind, or a search category for releases (sets the shape and the placeholder icon) */
  kind: PosterKind;
  title: string;
  className?: string;
  rounded?: string;
  /** small thumbnail: placeholder shows only an icon */
  compact?: boolean;
}) {
  const [stage, setStage] = useState(0); // 0 = src, 1 = fallback, 2 = placeholder
  const url = stage === 0 ? src || fallback : stage === 1 ? fallback : undefined;
  const { icon: Icon, square } = posterLook(kind);
  return (
    <div className={clsx('relative overflow-hidden bg-inset ring-1 ring-line', square ? 'aspect-square' : 'aspect-[2/3]', rounded, className)}>
      {url ? (
        <img
          key={url}
          src={url}
          alt={alt || title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setStage((s) => (s === 0 && fallback && src && fallback !== src ? 1 : 2))}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <div className={clsx('absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-accent/15 via-transparent to-fg/[0.04] text-center', compact ? 'p-1' : 'p-3')}>
          <Icon className={clsx('text-subtle', compact ? 'size-4' : 'size-7')} />
          {!compact && <span className="line-clamp-3 text-xs font-medium text-muted">{title}</span>}
        </div>
      )}
    </div>
  );
}

/** High-contrast chip for use on top of artwork. */
export function PosterBadge({ tone = 'neutral', icon: Icon, children }: { tone?: Tone; icon?: ComponentType<{ className?: string }>; children: ReactNode }) {
  const color = { neutral: 'text-white/70', accent: 'text-accent', ok: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-red-400', info: 'text-sky-400' }[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-[3px] text-[11px] leading-none font-semibold text-white shadow-sm ring-1 ring-white/10 backdrop-blur-md">
      {Icon && <Icon className={clsx('size-3', color, tone === 'ok' && 'fill-current')} />}
      {children}
    </span>
  );
}

/* ------------------------------ status ------------------------------ */

export interface DlInfo {
  progress: number;
  state: string;
}

export function useDownloadIndex(): Map<string, DlInfo> {
  const { data } = useDownloads();
  return useMemo(() => {
    const map = new Map<string, DlInfo>();
    for (const d of data?.items || []) {
      if (!d.media?.id || d.done) continue;
      const key = `${d.media.service}:${d.media.id}`;
      const prev = map.get(key);
      if (!prev || d.progress < prev.progress) map.set(key, { progress: d.progress, state: d.state });
    }
    return map;
  }, [data]);
}

export function mediaStatus(item: MediaItem, dl?: DlInfo): { tone: Tone; label: string; icon: ComponentType<{ className?: string }> } | undefined {
  if (dl) return { tone: 'info', label: `${Math.floor(dl.progress * 100)}%`, icon: LoaderCircle };
  switch (item.availability) {
    case 'available':
      return item.play ? { tone: 'ok', label: item.play.verb, icon: PLAY_ICON[item.play.verb] } : { tone: 'ok', label: 'Ready', icon: Check };
    case 'partial':
      return { tone: 'info', label: item.progress ? `${item.progress.have}/${item.progress.total}` : 'Partial', icon: CircleDashed };
    case 'missing':
      return { tone: 'warn', label: item.monitored === false ? 'Unmonitored' : 'Wanted', icon: Clock };
    case 'unreleased':
      return { tone: 'neutral', label: 'Soon', icon: Clock };
    default:
      return item.play ? { tone: 'ok', label: `In ${item.play.name}`, icon: PLAY_ICON[item.play.verb] } : undefined;
  }
}

/* ------------------------------ context (detail + quick add) ------------------------------ */

interface MediaCtx {
  open: (item: MediaItem) => void;
  quickAdd: (item: MediaItem) => Promise<void>;
  adding: Set<string>;
  current: MediaItem | null;
  close: () => void;
}

const Ctx = createContext<MediaCtx | null>(null);

export function MediaProvider({ children, renderDetail }: { children: ReactNode; renderDetail: (item: MediaItem | null, close: () => void) => ReactNode }) {
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const toast = useToast();
  const qc = useQueryClient();
  const { navigate } = useRouter();

  const quickAdd = useCallback(
    async (item: MediaItem) => {
      if (!canAdd(item)) return;
      setAdding((s) => new Set(s).add(item.key));
      try {
        // recommendations only carry a TMDB id: look the title up in Radarr / Sonarr first
        const target = item.raw ? item : await resolveMedia(item);
        if (target.inLibrary || !target.raw) {
          toast.info(target.inLibrary ? `${item.title} is already in your library` : `Could not find ${item.title}`);
          void qc.invalidateQueries({ queryKey: ['recs'] });
          setCurrent((c) => (c && c.key === item.key ? { ...target, reason: item.reason } : c));
          return;
        }
        const added = await addMedia(target.kind, { raw: target.raw });
        toast.success(`${item.title} added`, `${KIND_LABEL[item.kind]} is being searched for now - it will show up in Downloads.`, {
          label: 'View downloads',
          onClick: () => navigate('/downloads'),
        });
        void qc.invalidateQueries({ queryKey: ['library'] });
        void qc.invalidateQueries({ queryKey: ['search'] });
        void qc.invalidateQueries({ queryKey: ['recs'] });
        setTimeout(() => void qc.invalidateQueries({ queryKey: ['downloads'] }), 4000);
        setCurrent((c) => (c && c.key === item.key ? { ...added } : c));
      } catch (err) {
        toast.error(`Could not add ${item.title}`, errorMessage(err));
      } finally {
        setAdding((s) => {
          const n = new Set(s);
          n.delete(item.key);
          return n;
        });
      }
    },
    [toast, qc, navigate],
  );

  const value = useMemo(() => ({ open: setCurrent, quickAdd, adding, current, close: () => setCurrent(null) }), [quickAdd, adding, current]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {renderDetail(current, () => setCurrent(null))}
    </Ctx.Provider>
  );
}

export function useMedia(): MediaCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMedia outside provider');
  return v;
}

/* ------------------------------ card ------------------------------ */

export function MediaCard({
  item,
  dl,
  className,
  showKind,
  showReason,
  onDismiss,
}: {
  item: MediaItem;
  dl?: DlInfo;
  className?: string;
  showKind?: boolean;
  /** recommendations: "Because you watched ..." instead of the year line */
  showReason?: boolean;
  /** recommendations: "Not interested" */
  onDismiss?: () => void;
}) {
  const { open, quickAdd, adding } = useMedia();
  const status = mediaStatus(item, dl);
  const isAdding = adding.has(item.key);
  const PlayIcon = item.play ? PLAY_ICON[item.play.verb] : Play;
  return (
    <div className={clsx('group fade-up relative min-w-0', className)}>
      <button type="button" onClick={() => open(item)} className="block w-full text-left" aria-label={`${item.title} details`}>
        <div className="relative">
          <Poster src={item.poster} fallback={item.posterAlt} kind={item.kind} title={item.title} className="transition-transform duration-300 group-hover:scale-[1.02] group-hover:shadow-xl group-hover:shadow-black/30" />
          {(status || (showKind && onDismiss)) && (
            <div className="absolute top-2 left-2 flex flex-wrap gap-1">
              {status && (
                <PosterBadge tone={status.tone} icon={status.icon}>
                  {status.label}
                </PosterBadge>
              )}
              {/* the top right corner holds "Not interested" */}
              {showKind && onDismiss && <PosterBadge>{KIND_LABEL[item.kind]}</PosterBadge>}
            </div>
          )}
          {showKind && !onDismiss && (
            <div className="absolute top-2 right-2">
              <PosterBadge>{KIND_LABEL[item.kind]}</PosterBadge>
            </div>
          )}
          {dl && (
            <div className="absolute inset-x-2 bottom-2">
              <div className="h-1 overflow-hidden rounded-full bg-black/50">
                <div className="h-full bg-info" style={{ width: `${dl.progress * 100}%` }} />
              </div>
            </div>
          )}
        </div>
      </button>
      {/* hover actions */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[2/3] items-end justify-center gap-2 rounded-xl bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[square=true]:aspect-square" data-square={item.kind === 'album' || item.kind === 'artist'}>
        {item.play && (
          <a
            href={item.play.url}
            target="_blank"
            rel="noreferrer"
            title={playLabel(item.play)}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-black shadow-lg hover:bg-white/90"
          >
            <PlayIcon className={clsx('size-3.5', item.play.verb === 'Watch' && 'fill-current')} /> {item.play.verb}
          </a>
        )}
        {canAdd(item) && (
          <button
            type="button"
            onClick={() => void quickAdd(item)}
            disabled={isAdding}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white shadow-lg hover:bg-accent-strong disabled:opacity-70"
          >
            {isAdding ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Download
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          title="Not interested"
          aria-label={`Not interested in ${item.title}`}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/70 text-white/80 opacity-0 ring-1 ring-white/10 backdrop-blur-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-white focus-visible:opacity-100 max-md:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
      <div className="mt-2 px-0.5">
        <div className="truncate text-[13px] font-semibold" title={item.title}>
          {item.title}
        </div>
        {showReason && item.reason ? (
          <div className="line-clamp-2 text-xs text-muted" title={item.reason}>
            {item.reason}
          </div>
        ) : (
          <div className="truncate text-xs text-muted">{[item.year, item.subtitle].filter(Boolean).join(' · ') || KIND_LABEL[item.kind]}</div>
        )}
      </div>
    </div>
  );
}

export function MediaGrid({
  items,
  dlIndex,
  showKind,
  showReason,
  onDismiss,
  className,
}: {
  items: MediaItem[];
  dlIndex?: Map<string, DlInfo>;
  showKind?: boolean;
  showReason?: boolean;
  onDismiss?: (item: MediaItem) => void;
  className?: string;
}) {
  return (
    <div className={clsx('grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]', className)}>
      {items.map((it) => (
        <MediaCard
          key={it.key}
          item={it}
          dl={it.id ? dlIndex?.get(`${it.service}:${it.id}`) : undefined}
          showKind={showKind}
          showReason={showReason}
          onDismiss={onDismiss ? () => onDismiss(it) : undefined}
        />
      ))}
    </div>
  );
}

/** Horizontal scroller with arrow buttons on desktop. */
export function Row({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className={clsx('group/row relative', className)}>
      <div ref={ref} className="scroll-row no-scrollbar">
        {children}
      </div>
      <button
        type="button"
        onClick={() => scroll(-1)}
        aria-label="Scroll left"
        className="absolute top-1/3 -left-3 hidden size-9 -translate-y-1/2 place-items-center rounded-full border border-line bg-elev/95 text-fg opacity-0 shadow-lg transition-opacity group-hover/row:opacity-100 md:grid"
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => scroll(1)}
        aria-label="Scroll right"
        className="absolute top-1/3 -right-3 hidden size-9 -translate-y-1/2 place-items-center rounded-full border border-line bg-elev/95 text-fg opacity-0 shadow-lg transition-opacity group-hover/row:opacity-100 md:grid"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

export function downloadTitle(d: DownloadView): { title: string; subtitle?: string } {
  if (d.media) return { title: d.media.title, subtitle: d.media.subtitle };
  return { title: d.name };
}
