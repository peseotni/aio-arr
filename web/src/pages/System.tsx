import clsx from 'clsx';
import { Activity, CircleAlert, CircleCheck, ExternalLink, Globe, HardDrive, History, RefreshCw, Rss, ScanSearch, Server, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { bytes, relative } from '../lib/format';
import { useActivity, useApp, useIndexers, useStatus } from '../lib/queries';
import type { ServiceStatusView } from '../lib/types';
import { Poster } from '../components/media';
import { useToast } from '../components/overlay';
import { Badge, Button, Dot, ErrorNote, PageHeader, Progress, SectionHeader, Skeleton } from '../components/ui';

const GROUP_LABEL: Record<ServiceStatusView['group'], string> = {
  media: 'Media managers',
  indexer: 'Indexers',
  download: 'Download clients',
  player: 'Players',
  subtitles: 'Subtitles',
};

function ServiceCard({ s }: { s: ServiceStatusView }) {
  const errors = s.health.filter((h) => h.type === 'error');
  const warnings = s.health.filter((h) => h.type === 'warning' || h.type === 'notice');
  const tone = !s.enabled ? 'neutral' : !s.online || errors.length ? 'bad' : warnings.length ? 'warn' : 'ok';
  return (
    <div className={clsx('card flex flex-col p-4', !s.enabled && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Dot tone={tone} pulse={s.enabled && s.online && tone === 'ok'} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{s.name}</div>
            <div className="truncate text-xs text-muted">{!s.enabled ? 'Not configured' : s.online ? `v${String(s.version || '').replace(/^v/, '')}` : 'Offline'}</div>
          </div>
        </div>
        {s.enabled && (
          <a href={s.publicUrl} target="_blank" rel="noreferrer" title={`Open ${s.name}`} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-card-hover hover:text-fg">
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
      {s.error && <div className="mt-3 rounded-lg bg-bad/10 px-2.5 py-1.5 text-xs text-bad">{s.error}</div>}
      {[...errors, ...warnings].slice(0, 3).map((h, i) => (
        <div key={i} className={clsx('mt-2 flex items-start gap-1.5 text-xs', h.type === 'error' ? 'text-bad' : 'text-warn')}>
          {h.type === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {h.wikiUrl ? (
            <a href={h.wikiUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {h.message}
            </a>
          ) : (
            <span>{h.message}</span>
          )}
        </div>
      ))}
      {s.enabled && s.online && !s.health.length && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-ok">
          <CircleCheck className="size-3.5" /> Healthy
        </div>
      )}
    </div>
  );
}

export function SystemPage() {
  const { data, isLoading, error } = useStatus();
  const { data: app } = useApp();
  const { data: activity } = useActivity(40);
  const { data: indexers } = useIndexers(!!app?.services.prowlarr?.enabled);
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = app?.user.role === 'admin';
  const enabledArr = ['radarr', 'sonarr', 'lidarr', 'readarr'].filter((s) => app?.services[s]?.enabled);

  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
    } catch (err) {
      toast.error('Action failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const groups = (['media', 'indexer', 'download', 'player', 'subtitles'] as const).map((g) => ({ g, list: (data?.services || []).filter((s) => s.group === g && (s.enabled || isAdmin)) }));

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Activity}
        title="System"
        subtitle="Health of every service in your stack"
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={async () => {
              await api.get('/api/status?refresh=1');
              void qc.invalidateQueries({ queryKey: ['status'] });
            }}
          >
            Re-check
          </Button>
        }
      />
      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}

      {isAdmin && (
        <section className="card p-4">
          <SectionHeader title="Maintenance" icon={Server} subtitle="Run common tasks across all your apps at once" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={Rss}
              loading={busy === 'rss'}
              onClick={() => void run('rss', () => Promise.all(enabledArr.map((s) => api.post('/api/command', { service: s, name: 'RssSync' }))), 'RSS sync started')}
            >
              RSS sync
            </Button>
            <Button
              variant="secondary"
              icon={ScanSearch}
              loading={busy === 'missing'}
              onClick={() => void run('missing', () => Promise.all(enabledArr.map((s) => api.post(`/api/wanted/${s}/search`, {}))), 'Searching for everything missing')}
            >
              Search all missing
            </Button>
            <Button
              variant="secondary"
              icon={RefreshCw}
              loading={busy === 'refresh'}
              onClick={() => void run('refresh', () => Promise.all(enabledArr.map((s) => api.post('/api/command', { service: s, name: 'RefreshMonitoredDownloads' }))), 'Checking downloads')}
            >
              Check downloads
            </Button>
            {app?.services.jellyfin?.enabled && (
              <Button variant="secondary" icon={RefreshCw} loading={busy === 'jf'} onClick={() => void run('jf', () => api.post('/api/jellyfin/scan'), 'Jellyfin library scan started')}>
                Scan Jellyfin libraries
              </Button>
            )}
            {app?.services.prowlarr?.enabled && (
              <Button variant="secondary" icon={Globe} loading={busy === 'sync'} onClick={() => void run('sync', () => api.post('/api/command', { service: 'prowlarr', name: 'ApplicationIndexerSync' }), 'Indexers synced to your apps')}>
                Sync indexers
              </Button>
            )}
          </div>
        </section>
      )}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        groups.map(({ g, list }) =>
          list.length ? (
            <section key={g}>
              <SectionHeader title={GROUP_LABEL[g]} />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {list.map((s) => (
                  <ServiceCard key={s.id} s={s} />
                ))}
              </div>
            </section>
          ) : null,
        )
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {data?.disks.length ? (
          <section className="card p-5">
            <SectionHeader title="Storage" icon={HardDrive} />
            <div className="space-y-4">
              {data.disks.map((d) => {
                const used = 1 - d.free / d.total;
                return (
                  <div key={d.path}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-mono text-xs">{d.path}</span>
                      <span className="text-xs text-muted">
                        {bytes(d.free)} free of {bytes(d.total)}
                      </span>
                    </div>
                    <Progress value={used} tone={used > 0.9 ? 'bad' : used > 0.8 ? 'warn' : 'accent'} className="h-2" />
                    <div className="mt-1 text-[11px] text-subtle">Used by {d.services.join(', ')}</div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {indexers && (
          <section className="card p-5">
            <SectionHeader title="Indexers" icon={Globe} subtitle={`${indexers.filter((i) => i.enabled).length} enabled in Prowlarr`} />
            <div className="grid gap-2 sm:grid-cols-2">
              {indexers.map((i) => (
                <div key={i.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                  <Dot tone={!i.enabled ? 'neutral' : i.failing ? 'bad' : 'ok'} />
                  <span className="min-w-0 flex-1 truncate text-sm">{i.name}</span>
                  <Badge>{i.protocol}</Badge>
                  {i.failing && <Badge tone="bad">failing</Badge>}
                </div>
              ))}
              {!indexers.length && <div className="text-sm text-muted">No indexers configured in Prowlarr yet.</div>}
            </div>
          </section>
        )}
      </div>

      {activity && activity.length > 0 && (
        <section>
          <SectionHeader title="Recent activity" icon={History} subtitle="Grabs and imports across your *arr apps" />
          <div className="card divide-y divide-line">
            {activity.map((a) => (
              <div key={a.key} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="w-8 shrink-0">
                  <Poster src={a.poster} fallback={a.posterAlt} kind={a.service === 'sonarr' ? 'series' : a.service === 'lidarr' ? 'album' : a.service === 'readarr' ? 'book' : 'movie'} title={a.mediaTitle || a.title} rounded="rounded-md" compact />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.mediaTitle || a.title}</div>
                  <div className="truncate text-xs text-subtle" title={a.title}>
                    {a.title}
                  </div>
                </div>
                <Badge tone={/fail/i.test(a.event) ? 'bad' : /import/i.test(a.event) ? 'ok' : /grab/i.test(a.event) ? 'accent' : 'neutral'}>{a.event}</Badge>
                {a.quality && <span className="hidden text-xs text-muted md:inline">{a.quality}</span>}
                <span className="hidden w-24 text-right text-xs text-subtle sm:inline">{relative(a.date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
