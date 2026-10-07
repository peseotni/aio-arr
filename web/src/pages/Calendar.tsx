import clsx from 'clsx';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Disc3, Film, Tv, BookOpen } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { dayKey, time } from '../lib/format';
import { useCalendar } from '../lib/queries';
import type { CalendarEvent, MediaItem } from '../lib/types';
import { Poster, useMedia } from '../components/media';
import { Badge, Button, EmptyState, ErrorNote, PageHeader, Skeleton, Tabs } from '../components/ui';

const TYPE_ICON: Record<CalendarEvent['type'], ComponentType<{ className?: string }>> = { episode: Tv, movie: Film, album: Disc3, book: BookOpen };

function stub(e: CalendarEvent): MediaItem | null {
  if (!e.mediaId) return null;
  const kind = e.type === 'episode' ? 'series' : e.type === 'album' ? 'artist' : e.type;
  return {
    key: `${kind}:${e.mediaId}`,
    kind,
    service: e.service,
    id: e.mediaId,
    inLibrary: true,
    title: e.type === 'album' ? e.subtitle || e.title : e.title,
    poster: e.poster,
    posterAlt: e.posterAlt,
    availability: e.hasFile ? 'available' : 'missing',
    ids: {},
  };
}

function EventRow({ e }: { e: CalendarEvent }) {
  const { open } = useMedia();
  const Icon = TYPE_ICON[e.type];
  const item = stub(e);
  const past = Date.parse(e.date) < Date.now();
  return (
    <button type="button" disabled={!item} onClick={() => item && open(item)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-card-hover">
      <div className="w-10 shrink-0">
        <Poster src={e.poster} fallback={e.posterAlt} kind={e.type === 'episode' ? 'series' : e.type === 'album' ? 'album' : e.type} title={e.title} rounded="rounded-md" compact />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{e.title}</div>
        <div className="truncate text-xs text-muted">{e.subtitle}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {e.hasFile ? (
          <Badge tone="ok" icon={Check}>
            Downloaded
          </Badge>
        ) : past && e.monitored ? (
          <Badge tone="warn" icon={Clock}>
            Missing
          </Badge>
        ) : (
          <Badge icon={Icon}>{e.allDay ? e.dateType || e.type : time(e.date)}</Badge>
        )}
      </div>
    </button>
  );
}

function Agenda({ events }: { events: CalendarEvent[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const k = dayKey(new Date(e.date));
      m.set(k, [...(m.get(k) || []), e]);
    }
    return [...m.entries()];
  }, [events]);
  const today = dayKey(new Date());
  if (!groups.length) return <EmptyState icon={CalendarDays} title="Nothing scheduled">No episodes, movies or albums in this period.</EmptyState>;
  return (
    <div className="space-y-5">
      {groups.map(([k, list]) => {
        const d = new Date(`${k}T12:00:00`);
        return (
          <div key={k} className="grid gap-2 md:grid-cols-[140px_1fr]">
            <div className={clsx('pt-2', k === today ? 'text-accent' : 'text-muted')}>
              <div className="text-sm font-semibold">{k === today ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'long' })}</div>
              <div className="text-xs">{d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>
            </div>
            <div className="card divide-y divide-line p-1.5">
              {list.map((e) => (
                <EventRow key={e.key} e={e} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ events, month }: { events: CalendarEvent[]; month: Date }) {
  const { open } = useMedia();
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const k = dayKey(new Date(e.date));
      m.set(k, [...(m.get(k) || []), e]);
    }
    return m;
  }, [events]);
  const today = dayKey(new Date());
  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line bg-inset/60 text-center text-[11px] font-semibold tracking-wide text-subtle uppercase">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const k = dayKey(d);
          const list = byDay.get(k) || [];
          const other = d.getMonth() !== month.getMonth();
          return (
            <div key={k} className={clsx('min-h-24 border-r border-b border-line p-1.5 sm:min-h-28', other && 'bg-inset/40 opacity-60')}>
              <div className={clsx('mb-1 grid size-6 place-items-center rounded-full text-xs font-semibold', k === today ? 'bg-accent text-white' : 'text-muted')}>{d.getDate()}</div>
              <div className="space-y-1">
                {list.slice(0, 3).map((e) => {
                  const item = stub(e);
                  return (
                    <button
                      key={e.key}
                      type="button"
                      onClick={() => item && open(item)}
                      title={`${e.title} - ${e.subtitle || ''}`}
                      className={clsx(
                        'block w-full truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium',
                        e.hasFile ? 'bg-ok/15 text-ok' : e.type === 'movie' ? 'bg-accent/15 text-accent' : e.type === 'album' ? 'bg-info/15 text-info' : 'bg-fg/[0.07] text-fg',
                      )}
                    >
                      {e.title}
                    </button>
                  );
                })}
                {list.length > 3 && <div className="px-1 text-[10px] text-subtle">+{list.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<'agenda' | 'month'>('agenda');
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const range = useMemo(() => {
    if (view === 'agenda') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 3);
      return { start: start.toISOString(), end: new Date(start.getTime() + 35 * 86400000).toISOString() };
    }
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    start.setDate(start.getDate() - 7);
    return { start: start.toISOString(), end: new Date(start.getTime() + 50 * 86400000).toISOString() };
  }, [view, month]);
  const { data, isLoading, error } = useCalendar(range.start, range.end);

  return (
    <div>
      <PageHeader
        icon={CalendarDays}
        title="Calendar"
        subtitle="Upcoming episodes, movie releases and albums"
        actions={
          <>
            {view === 'month' && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" icon={ChevronLeft} onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month" />
                <span className="w-36 text-center text-sm font-semibold">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
                <Button size="sm" variant="ghost" icon={ChevronRight} onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month" />
              </div>
            )}
            <Tabs value={view} onChange={setView} items={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Month' }]} />
          </>
        }
      />
      {error && <ErrorNote>{String((error as Error).message)}</ErrorNote>}
      {data?.errors.length ? <ErrorNote className="mb-4">{data.errors.join(' · ')}</ErrorNote> : null}
      {isLoading ? <Skeleton className="h-96" /> : data && (view === 'agenda' ? <Agenda events={data.events} /> : <MonthGrid events={data.events} month={month} />)}
    </div>
  );
}
