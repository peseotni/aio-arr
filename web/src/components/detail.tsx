import clsx from 'clsx';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  Eye,
  HardDrive,
  ListFilter,
  Play,
  Plus,
  Search,
  Star,
  Trash,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { age, bytes, runtime, shortDate } from '../lib/format';
import { addMedia, useAddOptions, useApp, useDetail } from '../lib/queries';
import type { MediaDetail, MediaItem, ReleaseView, SeasonView } from '../lib/types';
import { KIND_LABEL, Poster, mediaStatus, useDownloadIndex, useMedia } from './media';
import { Modal, useConfirm, useToast } from './overlay';
import { Badge, Button, ErrorNote, Field, IconButton, Select, Skeleton, Spinner, Switch } from './ui';

const SERVICE_OF: Record<string, string> = { movie: 'radarr', series: 'sonarr', artist: 'lidarr', album: 'lidarr', book: 'readarr' };

export function MediaDetailModal({ item, onClose }: { item: MediaItem | null; onClose: () => void }) {
  return (
    <Modal open={!!item} onClose={onClose} size="xl" bare>
      {item && <DetailBody key={item.key} item={item} onClose={onClose} />}
    </Modal>
  );
}

function DetailBody({ item: initial, onClose }: { item: MediaItem; onClose: () => void }) {
  const detailKind = initial.kind === 'album' ? undefined : initial.kind;
  const { data, isLoading, error, refetch } = useDetail(initial.inLibrary ? detailKind : undefined, initial.id);
  const item = data?.item || initial;
  const dlIndex = useDownloadIndex();
  const dl = item.id ? dlIndex.get(`${item.service}:${item.id}`) : undefined;
  const status = mediaStatus(item, dl);
  const [showAdd, setShowAdd] = useState(false);
  const [releasesFor, setReleasesFor] = useState<{ title: string; query: string } | null>(null);
  const [bgFailed, setBgFailed] = useState(false);
  const bg = !bgFailed && item.fanart ? item.fanart : item.poster;

  return (
    <div className="relative">
      {/* hero */}
      <div className="relative">
        <div className="absolute inset-0 overflow-hidden">
          {bg ? (
            <img
              key={bg}
              src={bg}
              alt=""
              onError={() => setBgFailed(true)}
              className={clsx('size-full object-cover', bg !== item.fanart && 'scale-110 opacity-70 blur-2xl')}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="size-full bg-gradient-to-br from-accent/30 to-transparent" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/85 to-card/30" />
          <div className="absolute inset-0 bg-gradient-to-r from-card/90 via-card/40 to-transparent" />
        </div>
        <button type="button" onClick={onClose} className="absolute top-3 right-3 z-10 grid size-9 place-items-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60" aria-label="Close">
          <X className="size-4" />
        </button>
        <div className="relative flex flex-col gap-5 p-5 pt-16 sm:flex-row sm:items-end sm:p-7 sm:pt-24">
          <Poster src={item.poster} fallback={item.posterAlt} kind={item.kind} title={item.title} className="w-32 shrink-0 shadow-2xl sm:w-44" />
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="accent">{KIND_LABEL[item.kind]}</Badge>
              {status && (
                <Badge tone={status.tone} icon={status.icon}>
                  {dl ? `Downloading ${status.label}` : status.label === 'Watch' ? 'Available' : status.label}
                </Badge>
              )}
              {item.inLibrary && item.monitored === false && <Badge>Unmonitored</Badge>}
              {item.status && !['released', 'continuing'].includes(item.status) && item.kind !== 'album' && <Badge className="capitalize">{item.status}</Badge>}
            </div>
            <h2 className="text-2xl leading-tight font-bold tracking-tight sm:text-3xl">{item.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {item.year && <span>{item.year}</span>}
              {item.subtitle && <span>{item.subtitle}</span>}
              {runtime(item.runtime) && <span>{runtime(item.runtime)}</span>}
              {item.certification && <span className="rounded border border-line-strong px-1 text-xs">{item.certification}</span>}
              {item.rating && (
                <span className="inline-flex items-center gap-1">
                  <Star className="size-3.5 fill-warn text-warn" />
                  {item.rating}
                </span>
              )}
              {item.seasonCount ? <span>{item.seasonCount} seasons</span> : null}
              {item.sizeOnDisk ? (
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="size-3.5" />
                  {bytes(item.sizeOnDisk)}
                </span>
              ) : null}
            </div>
            {item.genres?.length ? <div className="mt-2 truncate text-xs text-subtle">{item.genres.slice(0, 5).join(' · ')}</div> : null}
            <ActionBar item={item} onAdd={() => setShowAdd((v) => !v)} onReleases={(q) => setReleasesFor(q)} onChanged={() => void refetch()} onDeleted={onClose} />
          </div>
        </div>
      </div>

      <div className="space-y-6 p-5 pt-2 sm:p-7 sm:pt-2">
        {showAdd && !item.inLibrary && <AddForm item={item} onDone={() => setShowAdd(false)} />}
        {item.overview && <p className="max-w-3xl text-sm leading-relaxed text-muted">{item.overview}</p>}
        {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {data && <DetailSections detail={data} onReleases={setReleasesFor} onChanged={() => void refetch()} />}
        {data?.links?.length ? (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {data.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-card-hover hover:text-fg">
                {l.label} <ExternalLink className="size-3" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {releasesFor && <ReleasePicker item={item} target={releasesFor} onClose={() => setReleasesFor(null)} />}
    </div>
  );
}

/* ------------------------------ actions ------------------------------ */

function ActionBar({
  item,
  onAdd,
  onReleases,
  onChanged,
  onDeleted,
}: {
  item: MediaItem;
  onAdd: () => void;
  onReleases: (t: { title: string; query: string }) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { quickAdd, adding } = useMedia();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: app } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = app?.user.role === 'admin';
  const listen = item.kind === 'artist' || item.kind === 'album';

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast.success(success);
      onChanged();
      void qc.invalidateQueries({ queryKey: ['library'] });
    } catch (err) {
      toast.error('Something went wrong', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const serviceLink = useMemo(() => {
    const svc = app?.services[SERVICE_OF[item.kind]];
    return svc?.enabled ? svc : undefined;
  }, [app, item.kind]);

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      {item.jellyfin && (
        <a href={item.jellyfin.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-black shadow-lg hover:bg-white/90">
          <Play className="size-4 fill-current" /> {listen ? 'Listen in Jellyfin' : 'Watch in Jellyfin'}
        </a>
      )}
      {!item.inLibrary && item.raw && (
        <>
          <Button variant="primary" icon={Download} loading={adding.has(item.key)} onClick={() => void quickAdd(item)}>
            Download
          </Button>
          <Button variant="secondary" icon={ListFilter} onClick={onAdd}>
            Options
          </Button>
        </>
      )}
      {item.inLibrary && item.id && (
        <>
          <Button
            variant={item.jellyfin ? 'secondary' : 'primary'}
            icon={Search}
            loading={busy === 'search'}
            onClick={() => void run('search', () => api.post(`/api/library/${item.kind}/${item.id}/search`), `Searching for ${item.title}`)}
          >
            Search now
          </Button>
          {(item.kind === 'movie' || item.kind === 'album' || item.kind === 'book') && (
            <Button variant="secondary" icon={ListFilter} onClick={() => onReleases({ title: item.title, query: `/api/library/${item.kind}/${item.id}/releases` })}>
              Pick release
            </Button>
          )}
          <Button
            variant="ghost"
            icon={item.monitored ? BookmarkCheck : Bookmark}
            loading={busy === 'monitor'}
            onClick={() => void run('monitor', () => api.post(`/api/library/${item.kind}/${item.id}/monitor`, { monitored: !item.monitored }))}
            title={item.monitored ? 'Monitored: new releases are downloaded automatically' : 'Not monitored'}
          >
            {item.monitored ? 'Monitored' : 'Monitor'}
          </Button>
          {isAdmin && item.kind !== 'album' && (
            <IconButton
              icon={Trash}
              label="Remove from library"
              variant="ghost"
              loading={busy === 'delete'}
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove ${item.title}?`,
                  message: `It will be removed from ${serviceLink ? app?.services[SERVICE_OF[item.kind]].name : 'the library'}.`,
                  confirmLabel: 'Remove',
                  danger: true,
                  checks: [{ id: 'files', label: 'Also delete the files from disk' }],
                });
                if (!ok) return;
                await run('delete', () => api.del(`/api/library/${item.kind}/${item.id}?deleteFiles=${ok.files ? 'true' : 'false'}`), `${item.title} removed`);
                onDeleted();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------ add form ------------------------------ */

function AddForm({ item, onDone }: { item: MediaItem; onDone: () => void }) {
  const service = SERVICE_OF[item.kind];
  const { data: opts, isLoading, error } = useAddOptions(service);
  const [form, setForm] = useState<Record<string, string | number | boolean | undefined>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const { open } = useMedia();

  useEffect(() => {
    if (!opts) return;
    setForm({
      qualityProfileId: opts.defaults.qualityProfileId,
      metadataProfileId: opts.defaults.metadataProfileId,
      rootFolderPath: opts.defaults.rootFolderPath,
      monitor: opts.defaults.monitor,
      minimumAvailability: opts.defaults.minimumAvailability,
      seriesType: opts.defaults.seriesType,
      search: opts.defaults.searchOnAdd,
    });
  }, [opts]);

  if (isLoading) return <Skeleton className="h-32" />;
  if (error) return <ErrorNote>{errorMessage(error)}</ErrorNote>;
  if (!opts) return null;
  const set = (k: string, v: string | number | boolean | undefined) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    try {
      const added = await addMedia(item.kind, { raw: item.raw, ...form });
      toast.success(`${item.title} added`, form.search ? 'Searching for a release now.' : undefined);
      void qc.invalidateQueries({ queryKey: ['library'] });
      void qc.invalidateQueries({ queryKey: ['search'] });
      onDone();
      open(added);
    } catch (err) {
      toast.error(`Could not add ${item.title}`, errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card fade-up grid gap-4 p-4 sm:grid-cols-2">
      <Field label="Quality profile">
        <Select value={String(form.qualityProfileId ?? '')} onChange={(e) => set('qualityProfileId', Number(e.target.value))}>
          {opts.qualityProfiles.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Root folder">
        <Select value={String(form.rootFolderPath ?? '')} onChange={(e) => set('rootFolderPath', e.target.value)}>
          {opts.rootFolders.map((r) => (
            <option key={r.path} value={r.path}>
              {r.path} {r.freeSpace ? `(${bytes(r.freeSpace)} free)` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {opts.metadataProfiles && (
        <Field label="Metadata profile">
          <Select value={String(form.metadataProfileId ?? '')} onChange={(e) => set('metadataProfileId', Number(e.target.value))}>
            {opts.metadataProfiles.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {item.kind === 'series' && (
        <>
          <Field label="Monitor">
            <Select value={String(form.monitor ?? 'all')} onChange={(e) => set('monitor', e.target.value)}>
              <option value="all">All episodes</option>
              <option value="future">Future episodes</option>
              <option value="missing">Missing episodes</option>
              <option value="existing">Existing episodes</option>
              <option value="firstSeason">First season</option>
              <option value="lastSeason">Last season</option>
              <option value="pilot">Pilot episode</option>
              <option value="none">None</option>
            </Select>
          </Field>
          <Field label="Series type">
            <Select value={String(form.seriesType ?? 'standard')} onChange={(e) => set('seriesType', e.target.value)}>
              <option value="standard">Standard</option>
              <option value="daily">Daily</option>
              <option value="anime">Anime</option>
            </Select>
          </Field>
        </>
      )}
      {item.kind === 'artist' && (
        <Field label="Monitor">
          <Select value={String(form.monitor ?? 'all')} onChange={(e) => set('monitor', e.target.value)}>
            <option value="all">All albums</option>
            <option value="future">Future albums</option>
            <option value="missing">Missing albums</option>
            <option value="existing">Existing albums</option>
            <option value="latest">Latest album</option>
            <option value="first">First album</option>
            <option value="none">None</option>
          </Select>
        </Field>
      )}
      {item.kind === 'movie' && (
        <Field label="Minimum availability">
          <Select value={String(form.minimumAvailability ?? 'released')} onChange={(e) => set('minimumAvailability', e.target.value)}>
            <option value="announced">Announced</option>
            <option value="inCinemas">In cinemas</option>
            <option value="released">Released</option>
          </Select>
        </Field>
      )}
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={!!form.search} onChange={(v) => set('search', v)} label="Search now" />
          Start searching right away
        </label>
        <Button variant="primary" icon={Plus} loading={busy} onClick={() => void submit()}>
          Add {KIND_LABEL[item.kind].toLowerCase()}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ sections ------------------------------ */

function DetailSections({ detail, onReleases, onChanged }: { detail: MediaDetail; onReleases: (t: { title: string; query: string }) => void; onChanged: () => void }) {
  return (
    <>
      {detail.files?.length ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Files</h3>
          <div className="overflow-hidden rounded-xl border border-line">
            {detail.files.map((f) => (
              <div key={f.path} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3.5 py-2.5 text-sm last:border-0">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={f.path}>
                  {f.path.split('/').pop()}
                </span>
                {f.quality && <Badge tone="accent">{f.quality}</Badge>}
                {f.videoCodec && <span className="text-xs text-muted">{f.videoCodec}</span>}
                {f.audio && <span className="text-xs text-muted">{f.audio}</span>}
                {f.subtitles?.length ? <span className="text-xs text-muted">Subs: {f.subtitles.slice(0, 4).join(', ')}</span> : null}
                <span className="text-xs tabular-nums text-subtle">{bytes(f.size)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {detail.seasons && <Seasons seriesId={detail.item.id!} seasons={detail.seasons} onReleases={onReleases} onChanged={onChanged} />}
      {detail.albums && <Albums albums={detail.albums} onReleases={onReleases} onChanged={onChanged} />}
    </>
  );
}

function Seasons({ seriesId, seasons, onReleases, onChanged }: { seriesId: number; seasons: SeasonView[]; onReleases: (t: { title: string; query: string }) => void; onChanged: () => void }) {
  const [openSeason, setOpenSeason] = useState<number | null>(seasons.find((s) => s.seasonNumber > 0)?.seasonNumber ?? null);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast.success(msg);
      onChanged();
    } catch (err) {
      toast.error('Something went wrong', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Seasons</h3>
      <div className="space-y-2">
        {seasons.map((s) => {
          const name = s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`;
          const complete = s.episodeCount > 0 && s.episodeFileCount >= s.episodeCount;
          const isOpen = openSeason === s.seasonNumber;
          return (
            <div key={s.seasonNumber} className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center gap-3 px-3.5 py-2.5">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setOpenSeason(isOpen ? null : s.seasonNumber)}>
                  <ChevronDown className={clsx('size-4 shrink-0 text-subtle transition-transform', !isOpen && '-rotate-90')} />
                  <span className="font-medium">{name}</span>
                  <Badge tone={complete ? 'ok' : s.episodeFileCount > 0 ? 'info' : s.episodeCount > 0 ? 'warn' : 'neutral'}>
                    {s.episodeFileCount}/{s.episodeCount || s.totalEpisodeCount}
                  </Badge>
                  {s.sizeOnDisk > 0 && <span className="hidden text-xs text-subtle sm:inline">{bytes(s.sizeOnDisk)}</span>}
                </button>
                <Switch
                  checked={s.monitored}
                  label={`Monitor ${name}`}
                  onChange={(v) => void run(`m${s.seasonNumber}`, () => api.post(`/api/library/series/${seriesId}/monitor`, { monitored: v, seasonNumber: s.seasonNumber }))}
                />
                <IconButton
                  icon={Search}
                  size="sm"
                  label={`Search ${name}`}
                  loading={busy === `s${s.seasonNumber}`}
                  onClick={() => void run(`s${s.seasonNumber}`, () => api.post(`/api/library/series/${seriesId}/search`, { seasonNumber: s.seasonNumber }), `Searching ${name}`)}
                />
                <IconButton
                  icon={ListFilter}
                  size="sm"
                  label={`Pick a release for ${name}`}
                  onClick={() => onReleases({ title: name, query: `/api/library/series/${seriesId}/releases?seasonNumber=${s.seasonNumber}` })}
                />
              </div>
              {isOpen && (
                <div className="border-t border-line bg-inset/50">
                  {s.episodes.length === 0 && <div className="px-4 py-3 text-sm text-muted">No episodes listed yet.</div>}
                  {s.episodes.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-sm last:border-0">
                      <span className="w-9 shrink-0 text-xs font-semibold tabular-nums text-subtle">E{String(e.episodeNumber).padStart(2, '0')}</span>
                      <span className={clsx('grid size-5 shrink-0 place-items-center rounded-full', e.hasFile ? 'bg-ok/15 text-ok' : e.aired && e.monitored ? 'bg-warn/15 text-warn' : 'bg-fg/[0.06] text-subtle')}>
                        {e.hasFile ? <Check className="size-3" /> : <Clock className="size-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate" title={e.overview}>
                          {e.title || 'TBA'}
                        </div>
                        <div className="text-xs text-subtle">
                          {e.airDate ? shortDate(e.airDate) : 'TBA'}
                          {e.quality ? ` · ${e.quality}` : ''}
                          {e.size ? ` · ${bytes(e.size)}` : ''}
                        </div>
                      </div>
                      {!e.hasFile && e.aired && (
                        <>
                          <IconButton
                            icon={Search}
                            size="sm"
                            label="Search episode"
                            loading={busy === `e${e.id}`}
                            onClick={() => void run(`e${e.id}`, () => api.post(`/api/library/series/${seriesId}/search`, { episodeIds: [e.id] }), `Searching ${e.title || 'episode'}`)}
                          />
                          <IconButton icon={ListFilter} size="sm" label="Pick a release" onClick={() => onReleases({ title: e.title, query: `/api/library/series/${seriesId}/releases?episodeId=${e.id}` })} />
                        </>
                      )}
                      <Switch
                        checked={e.monitored}
                        label="Monitor episode"
                        onChange={(v) => void run(`me${e.id}`, () => api.post(`/api/library/series/${seriesId}/monitor`, { monitored: v, episodeIds: [e.id] }))}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Albums({ albums, onReleases, onChanged }: { albums: MediaItem[]; onReleases: (t: { title: string; query: string }) => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast.success(msg);
      onChanged();
    } catch (err) {
      toast.error('Something went wrong', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Albums</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {albums.map((a) => {
          const st = mediaStatus(a);
          return (
            <div key={a.key} className="flex items-center gap-3 rounded-xl border border-line p-2">
              <Poster src={a.poster} fallback={a.posterAlt} kind="album" title={a.title} className="w-12 shrink-0" rounded="rounded-lg" compact />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.title}</div>
                <div className="flex items-center gap-2 text-xs text-subtle">
                  {a.year}
                  {a.status && <span className="capitalize">{a.status}</span>}
                  {st && <Badge tone={st.tone}>{st.label}</Badge>}
                </div>
              </div>
              {a.jellyfin && (
                <a href={a.jellyfin.url} target="_blank" rel="noreferrer" title="Listen in Jellyfin" className="grid size-7 place-items-center rounded-lg text-ok hover:bg-ok/10">
                  <Play className="size-3.5 fill-current" />
                </a>
              )}
              <IconButton icon={Search} size="sm" label="Search album" loading={busy === `s${a.id}`} onClick={() => void run(`s${a.id}`, () => api.post(`/api/library/album/${a.id}/search`), `Searching ${a.title}`)} />
              <IconButton icon={ListFilter} size="sm" label="Pick a release" onClick={() => onReleases({ title: a.title, query: `/api/library/album/${a.id}/releases` })} />
              <Switch checked={!!a.monitored} label="Monitor album" onChange={(v) => void run(`m${a.id}`, () => api.post(`/api/library/album/${a.id}/monitor`, { monitored: v }))} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------ release picker ------------------------------ */

export function ReleasePicker({ item, target, onClose }: { item: MediaItem; target: { title: string; query: string }; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; releases?: ReleaseView[]; error?: string }>({ loading: true });
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    api
      .get<ReleaseView[]>(target.query)
      .then((releases) => !cancelled && setState({ loading: false, releases }))
      .catch((err) => !cancelled && setState({ loading: false, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [target.query]);

  const grab = async (r: ReleaseView) => {
    if (r.rejected) {
      const ok = await confirm({
        title: 'Grab a rejected release?',
        message: (
          <ul className="list-disc space-y-1 pl-4">
            {(r.rejections || []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ),
        confirmLabel: 'Grab anyway',
      });
      if (!ok) return;
    }
    setGrabbing(r.guid);
    try {
      await api.post('/api/releases/grab', { service: item.service, guid: r.guid, indexerId: r.indexerId });
      toast.success('Sent to your download client', r.title);
      void qc.invalidateQueries({ queryKey: ['downloads'] });
      onClose();
    } catch (err) {
      toast.error('Grab failed', errorMessage(err));
    } finally {
      setGrabbing(null);
    }
  };

  const list = (state.releases || []).filter((r) => showRejected || !r.rejected);
  const rejectedCount = (state.releases || []).filter((r) => r.rejected).length;

  return (
    <Modal open onClose={onClose} size="xl" title={`Releases · ${item.title}${target.title !== item.title ? ` · ${target.title}` : ''}`}>
      {state.loading && (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
          <Spinner className="size-7" />
          Searching all indexers - this can take up to a minute…
        </div>
      )}
      {state.error && <ErrorNote>{state.error}</ErrorNote>}
      {state.releases && (
        <>
          <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted">
            <span>
              {list.length} releases{rejectedCount ? ` · ${rejectedCount} rejected by your profile` : ''}
            </span>
            {rejectedCount > 0 && (
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={showRejected} onChange={setShowRejected} label="Show rejected" /> Show rejected
              </label>
            )}
          </div>
          {list.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted">No releases found.</div>
          ) : (
            <div className="space-y-1.5">
              {list.map((r) => (
                <div key={`${r.indexerId}:${r.guid}`} className={clsx('flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center', r.rejected && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={r.title}>
                      {r.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {r.quality && <Badge tone="accent">{r.quality}</Badge>}
                      <Badge tone={r.protocol === 'usenet' ? 'info' : 'neutral'}>{r.protocol}</Badge>
                      <span>{bytes(r.size)}</span>
                      <span>· {age(r.ageHours)}</span>
                      {r.protocol === 'torrent' && r.seeders !== undefined && (
                        <span className={clsx(r.seeders > 10 ? 'text-ok' : r.seeders > 0 ? 'text-warn' : 'text-bad')}>
                          · {r.seeders} seeders
                        </span>
                      )}
                      <span>· {r.indexer}</span>
                      {r.customFormatScore ? <span>· score {r.customFormatScore}</span> : null}
                      {r.languages?.length ? <span>· {r.languages.join(', ')}</span> : null}
                    </div>
                    {r.rejected && r.rejections?.length ? <div className="mt-1 truncate text-xs text-warn">{r.rejections[0]}</div> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {r.infoUrl && (
                      <a href={r.infoUrl} target="_blank" rel="noreferrer" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-card-hover hover:text-fg" title="Indexer page">
                        <Eye className="size-4" />
                      </a>
                    )}
                    <Button size="sm" variant={r.rejected ? 'secondary' : 'primary'} icon={Download} loading={grabbing === r.guid} onClick={() => void grab(r)}>
                      Grab
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
