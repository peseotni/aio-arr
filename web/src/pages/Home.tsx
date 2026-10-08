import clsx from 'clsx';
import {
  ArrowDown,
  CalendarDays,
  Check,
  Clapperboard,
  Download,
  Film,
  HardDrive,
  Mic,
  MonitorPlay,
  Play,
  Plug,
  Sparkles,
  TriangleAlert,
  Tv,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { bytes, duration, pct, speed, time } from '../lib/format';
import { useApp, useCalendar, useDownloads, useJellyfinHome, useLibrary, useRecommendations, useSessions, useStatus, type JellyfinCard } from '../lib/queries';
import { Link } from '../lib/router';
import type { CalendarEvent, DownloadView } from '../lib/types';
import { Poster, Row, downloadTitle } from '../components/media';
import { RecommendationRow, mixedKinds } from '../components/recs';
import { Badge, Button, EmptyState, Progress, SectionHeader, Skeleton, StatCard, buttonClass } from '../components/ui';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function ResumeCard({ c }: { c: JellyfinCard }) {
  // backdrop first, then the poster, then a placeholder
  const [stage, setStage] = useState(0);
  const img = [c.backdrop, c.image].filter(Boolean)[stage];
  return (
    <a href={c.url} target="_blank" rel="noreferrer" className="group w-64 shrink-0 sm:w-72">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-inset ring-1 ring-line">
        {img ? (
          <img key={img} src={img} alt="" loading="lazy" onError={() => setStage((s) => s + 1)} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className="grid size-full place-items-center">
            <Clapperboard className="size-8 text-subtle" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <div className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
          <span className="grid size-12 place-items-center rounded-full bg-white/95 text-black shadow-xl">
            <Play className="ml-0.5 size-5 fill-current" />
          </span>
        </div>
        {c.progress !== undefined && (
          <div className="absolute inset-x-3 bottom-2.5">
            <div className="h-1 overflow-hidden rounded-full bg-white/25">
              <div className="h-full rounded-full bg-accent" style={{ width: `${c.progress * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <div className="truncate text-[13px] font-semibold">{c.name}</div>
        <div className="truncate text-xs text-muted">{c.subtitle || c.type}</div>
      </div>
    </a>
  );
}

function LatestCard({ c }: { c: JellyfinCard }) {
  const square = c.type === 'MusicAlbum' || c.type === 'Audio';
  return (
    <a href={c.url} target="_blank" rel="noreferrer" className="group w-32 shrink-0 sm:w-36">
      <div className="relative">
        <Poster src={c.image} kind={square ? 'album' : c.type === 'Series' || c.type === 'Episode' ? 'series' : 'movie'} title={c.name} className="transition-transform group-hover:scale-[1.03]" />
        <div className="absolute inset-0 grid place-items-center rounded-xl bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Play className="size-8 fill-white text-white" />
        </div>
      </div>
      <div className="mt-2 truncate text-[13px] font-semibold">{c.name}</div>
      <div className="truncate text-xs text-muted">{c.subtitle || ''}</div>
    </a>
  );
}

function DownloadMini({ d }: { d: DownloadView }) {
  const { title, subtitle } = downloadTitle(d);
  const active = ['downloading', 'metadata', 'stalled', 'checking'].includes(d.state);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-9 shrink-0">
        <Poster src={d.media?.poster} fallback={d.media?.posterAlt} kind={d.media?.kind || 'file'} title={title} rounded="rounded-md" compact />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium" title={d.name}>
            {title}
          </span>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-muted">{pct(d.progress)}</span>
        </div>
        <Progress value={d.progress} tone={d.state === 'stalled' ? 'warn' : d.state === 'failed' || d.state === 'error' ? 'bad' : d.done ? 'ok' : 'accent'} active={active && d.downloadSpeed > 0} className="mt-1.5" />
        <div className="mt-1 flex justify-between gap-2 text-[11px] text-subtle">
          <span className="truncate">{subtitle || d.clientName}</span>
          <span className="shrink-0 tabular-nums">{d.downloadSpeed > 0 ? `${speed(d.downloadSpeed)} · ${duration(d.eta)}` : d.state}</span>
        </div>
      </div>
    </div>
  );
}

function UpcomingItem({ e }: { e: CalendarEvent }) {
  const d = new Date(e.date);
  const today = new Date().toDateString() === d.toDateString();
  return (
    <div className="flex items-center gap-3 py-2">
      <div className={clsx('w-12 shrink-0 rounded-lg py-1 text-center', today ? 'bg-accent/15 text-accent' : 'bg-fg/[0.05] text-muted')}>
        <div className="text-[10px] font-semibold uppercase">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
        <div className="text-base leading-tight font-bold">{d.getDate()}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{e.title}</div>
        <div className="truncate text-xs text-muted">
          {e.subtitle}
          {!e.allDay ? ` · ${time(e.date)}` : ''}
        </div>
      </div>
      {e.hasFile ? <Badge tone="ok" icon={Check}>Ready</Badge> : <Badge tone={e.type === 'movie' ? 'accent' : e.type === 'album' ? 'info' : 'neutral'}>{e.type === 'episode' ? 'TV' : e.type}</Badge>}
    </div>
  );
}

export function HomePage() {
  const { data: app } = useApp();
  const svc = app?.services || {};
  const isAdmin = app?.user.role === 'admin';
  const jfOn = !!svc.jellyfin?.enabled;
  const { data: status } = useStatus();
  const { data: downloads } = useDownloads();
  const { data: jf, isLoading: jfLoading } = useJellyfinHome(jfOn);
  const { data: sessions } = useSessions(jfOn);
  const { data: recs } = useRecommendations(!!app?.features.recommendations);
  const { data: movies } = useLibrary('movie', !!svc.radarr?.enabled);
  const { data: series } = useLibrary('series', !!svc.sonarr?.enabled);
  const { data: artists } = useLibrary('artist', !!svc.lidarr?.enabled);
  const range = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 86400000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);
  const { data: cal } = useCalendar(range.start, range.end);

  const configured = Object.values(svc).some((s) => s.enabled) || (app?.clients.length || 0) > 0;
  const active = (downloads?.items || []).filter((d) => !d.done && !d.inHistory).slice(0, 6);
  const upcoming = (cal?.events || []).filter((e) => Date.parse(e.date) >= Date.now() - 6 * 3600000).slice(0, 7);
  const issues = (status?.services || []).flatMap((s) => [
    ...(s.enabled && !s.online ? [{ service: s.name, type: 'error', message: s.error || 'Not reachable' }] : []),
    ...s.health.filter((h) => h.type === 'error' || h.type === 'warning').map((h) => ({ service: s.name, type: h.type, message: h.message })),
  ]);
  const disk = (status?.disks || []).slice().sort((a, b) => b.total - a.total)[0];
  const resume = [...(jf?.resume || []), ...(jf?.nextUp || [])];

  if (app && !configured) {
    return (
      <EmptyState
        icon={Plug}
        title="Let's connect your services"
        action={isAdmin && (
          <Link to="/settings">
            <Button variant="primary" icon={Plug}>
              Open settings
            </Button>
          </Link>
        )}
      >
        Add Radarr, Sonarr, Prowlarr, Jellyfin and your download client. AIO Arr can detect most of them automatically.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-9">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {greeting()}
            {app ? `, ${app.user.username}` : ''}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · here's what's happening in your library
          </p>
        </div>
        {app?.watchApp && (
          <a href={app.watchApp.url} target="_blank" rel="noreferrer" className={buttonClass('outline')}>
            <MonitorPlay className="size-4" /> Open {app.watchApp.name}
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {svc.radarr?.enabled && <Link to="/movies"><StatCard icon={Film} label="Movies" value={movies ? movies.length.toLocaleString() : '…'} sub={movies ? `${movies.filter((m) => m.availability === 'available').length.toLocaleString()} available` : undefined} /></Link>}
        {svc.sonarr?.enabled && <Link to="/tv"><StatCard icon={Tv} label="TV shows" value={series ? series.length.toLocaleString() : '…'} sub={series ? `${series.reduce((n, s) => n + (s.progress?.have || 0), 0).toLocaleString()} episodes` : undefined} tone="info" /></Link>}
        {svc.lidarr?.enabled && <Link to="/music"><StatCard icon={Mic} label="Artists" value={artists ? artists.length.toLocaleString() : '…'} sub={artists ? `${artists.reduce((n, a) => n + (a.progress?.have || 0), 0).toLocaleString()} tracks` : undefined} tone="ok" /></Link>}
        <Link to="/downloads">
          <StatCard icon={ArrowDown} label="Downloading" value={downloads ? downloads.totals.active : '…'} sub={downloads ? speed(downloads.totals.downloadSpeed) : undefined} tone="warn" />
        </Link>
        {disk && <StatCard icon={HardDrive} label="Free space" value={bytes(disk.free)} sub={`of ${bytes(disk.total)} · ${disk.path}`} tone={disk.free / disk.total < 0.1 ? 'bad' : 'neutral'} />}
      </div>

      {issues.length > 0 && (
        <div className="card border-warn/30 bg-warn/[0.06] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn">
            <TriangleAlert className="size-4" /> {issues.length === 1 ? '1 thing needs attention' : `${issues.length} things need attention`}
          </div>
          <ul className="space-y-1 text-sm text-muted">
            {issues.slice(0, 4).map((i, idx) => (
              <li key={idx} className="truncate">
                <span className="font-medium text-fg">{i.service}:</span> {i.message}
              </li>
            ))}
          </ul>
          {issues.length > 4 && (
            <Link to="/system" className="mt-2 inline-block text-xs font-semibold text-accent hover:underline">
              See all in System →
            </Link>
          )}
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <section>
          <SectionHeader title="Now playing" icon={MonitorPlay} subtitle="Active Jellyfin sessions" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sessions.map((s) => (
              <div key={s.id} className="card flex items-center gap-3 p-3">
                <div className="w-12 shrink-0">
                  <Poster src={s.image} kind="movie" title={s.title} rounded="rounded-lg" compact />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{s.title}</div>
                  <div className="truncate text-xs text-muted">{s.subtitle}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Progress value={s.progress || 0} tone={s.paused ? 'neutral' : 'ok'} />
                  </div>
                  <div className="mt-1 truncate text-[11px] text-subtle">
                    {s.user} · {s.device} {s.transcoding ? '· transcoding' : ''} {s.paused ? '· paused' : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {jfOn && (jfLoading || resume.length > 0) && (
        <section>
          <SectionHeader title="Continue watching" icon={Play} subtitle="Pick up where you left off - opens in Jellyfin" />
          {jfLoading ? (
            <div className="flex gap-4 overflow-hidden">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="aspect-video w-72 shrink-0" />
              ))}
            </div>
          ) : (
            <Row>
              {resume.map((c) => (
                <ResumeCard key={c.id} c={c} />
              ))}
            </Row>
          )}
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card p-5">
          <SectionHeader
            title="Downloading now"
            icon={Download}
            subtitle={downloads ? `${speed(downloads.totals.downloadSpeed)} down · ${speed(downloads.totals.uploadSpeed)} up` : undefined}
            action={
              <Link to="/downloads" className="text-xs font-semibold text-accent hover:underline">
                View all
              </Link>
            }
          />
          {!downloads ? (
            <Skeleton className="h-32" />
          ) : active.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">Nothing downloading right now.</div>
          ) : (
            <div className="divide-y divide-line">
              {active.map((d) => (
                <DownloadMini key={d.key} d={d} />
              ))}
            </div>
          )}
        </section>
        <section className="card p-5">
          <SectionHeader
            title="Coming up"
            icon={CalendarDays}
            subtitle="Next 7 days"
            action={
              <Link to="/calendar" className="text-xs font-semibold text-accent hover:underline">
                Calendar
              </Link>
            }
          />
          {!cal ? (
            <Skeleton className="h-32" />
          ) : upcoming.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">Nothing scheduled this week.</div>
          ) : (
            <div className="divide-y divide-line">
              {upcoming.map((e) => (
                <UpcomingItem key={e.key} e={e} />
              ))}
            </div>
          )}
        </section>
      </div>

      {jf?.latest && jf.latest.length > 0 && (
        <section>
          <SectionHeader title="Recently added" icon={Sparkles} subtitle="New in Jellyfin" />
          <Row>
            {jf.latest.map((c) => (
              <LatestCard key={c.id} c={c} />
            ))}
          </Row>
        </section>
      )}

      {recs?.sections.slice(0, 2).map((s, i) => (
        <section key={s.id}>
          <SectionHeader
            title={s.title}
            icon={Sparkles}
            subtitle={s.subtitle || 'One click to download'}
            action={
              i === 0 && (
                <Link to="/for-you" className="shrink-0 text-xs font-semibold text-accent hover:underline">
                  More for you
                </Link>
              )
            }
          />
          <RecommendationRow section={s} showKind={mixedKinds(s)} />
        </section>
      ))}

    </div>
  );
}
