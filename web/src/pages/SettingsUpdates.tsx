/* Settings > Updates: one-click updates of the apps' Docker containers. */
import clsx from 'clsx';
import { ArrowUpCircle, Box, ChevronDown, CircleAlert, CircleCheck, Container, LoaderCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { relative } from '../lib/format';
import { useUpdates } from '../lib/queries';
import type { AppUpdateView, UpdateJobView, UpdatesResponse } from '../lib/types';
import { useConfirm, useToast } from '../components/overlay';
import { Badge, Button, ErrorNote, InfoNote, Skeleton, type Tone } from '../components/ui';

const STATE: Record<AppUpdateView['state'], { label: string; tone: Tone }> = {
  available: { label: 'Update available', tone: 'accent' },
  'up-to-date': { label: 'Up to date', tone: 'ok' },
  unknown: { label: 'Not checked', tone: 'neutral' },
  local: { label: 'Built locally', tone: 'neutral' },
  error: { label: 'Check failed', tone: 'bad' },
};

const JOB_TEXT: Record<UpdateJobView['status'], string> = {
  queued: 'Waiting…',
  pulling: 'Downloading the new version…',
  recreating: 'Restarting with the new version…',
  waiting: 'Waiting for it to come back up…',
  done: 'Updated',
  failed: 'Update failed',
  'up-to-date': 'Already up to date',
};

const running = (j?: UpdateJobView) => !!j && !j.finishedAt;

function DockerHelp({ error }: { error?: string }) {
  return (
    <div className="card max-w-3xl space-y-4 p-5">
      <div className="flex gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <Container className="size-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">Connect Docker to update your apps with one click</div>
          <p className="mt-1 text-sm text-muted">
            AIO Arr updates apps the way Watchtower does: it downloads the new image and recreates the container with exactly the same settings, volumes and networks.
          </p>
        </div>
      </div>
      <div className="text-sm">
        <div className="mb-1.5 font-medium">Add the Docker socket to the aio-arr service in your docker-compose.yml, then run docker compose up -d:</div>
        <pre className="overflow-x-auto rounded-xl border border-line bg-inset p-3 font-mono text-xs leading-relaxed">{`    volumes:
      - ./config:/config
      - /var/run/docker.sock:/var/run/docker.sock`}</pre>
        <p className="mt-2 text-xs text-muted">
          Or set <code className="font-mono">DOCKER_HOST=tcp://socket-proxy:2375</code> to use a Docker socket proxy that allows containers, images, networks and distribution with POST requests.
        </p>
      </div>
      <InfoNote tone="warn">
        Access to Docker lets AIO Arr control every container on this machine, which is as powerful as root. Only admins can use updates - keep AIO Arr behind its login and use strong passwords.
      </InfoNote>
      {error && <div className="text-xs text-subtle">Docker: {error}</div>}
    </div>
  );
}

function AppRow({ a, job, busy, onUpdate }: { a: AppUpdateView; job?: UpdateJobView; busy: boolean; onUpdate: () => void }) {
  const st = STATE[a.state];
  const active = running(job);
  // after a check that could not tell (registry unreachable ...) you can still try: it only restarts when the image changed
  const canUpdate = a.state === 'available' || ((a.state === 'unknown' || a.state === 'error') && !!a.checkedAt);
  return (
    <div className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className={clsx('grid size-10 shrink-0 place-items-center rounded-xl', a.app ? 'bg-accent/12 text-accent' : 'bg-fg/[0.06] text-muted')}>
          <Box className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{a.appName}</span>
            {a.version && <span className="text-xs text-muted">v{a.version.replace(/^v/, '')}</span>}
            {!active && (
              <Badge tone={st.tone} className={clsx(a.message && 'cursor-help')}>
                <span title={a.message}>{a.state === 'unknown' && a.checkedAt ? 'Unknown' : st.label}</span>
              </Badge>
            )}
            {a.connected && <Badge>Connected</Badge>}
            {!a.running && <Badge tone="warn">Stopped</Badge>}
          </div>
          <div className="truncate font-mono text-[11px] text-subtle" title={a.image}>
            {a.name} · {a.image}
          </div>
          {a.dependents?.length ? <div className="mt-0.5 text-xs text-muted">Also restarts {a.dependents.join(', ')} (they share its network)</div> : null}
          {a.self && <div className="mt-0.5 text-xs text-muted">This is AIO Arr itself - it restarts and this page reconnects after a few seconds.</div>}
          {a.state === 'local' && <div className="mt-0.5 text-xs text-muted">Built from source on this machine: update it with git pull and docker compose up -d --build.</div>}
          {job && (
            <div className={clsx('mt-1 flex items-center gap-1.5 text-xs', job.status === 'failed' ? 'text-bad' : job.finishedAt ? 'text-ok' : 'text-info')}>
              {active ? <LoaderCircle className="size-3.5 animate-spin" /> : job.status === 'failed' ? <CircleAlert className="size-3.5" /> : <CircleCheck className="size-3.5" />}
              <span className="truncate" title={job.message}>
                {job.status === 'done' ? job.message || JOB_TEXT.done : `${JOB_TEXT[job.status]}${job.message ? ` - ${job.message}` : ''}`}
              </span>
            </div>
          )}
        </div>
      </div>
      {canUpdate && !active && (
        <Button size="sm" variant={a.state === 'available' ? 'primary' : 'ghost'} icon={ArrowUpCircle} loading={busy} onClick={onUpdate} className="self-end sm:self-auto">
          {a.state === 'available' ? 'Update' : 'Try update'}
        </Button>
      )}
    </div>
  );
}

export function UpdatesPanel() {
  const { data, isLoading, error } = useUpdates(true);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  if (isLoading) return <Skeleton className="h-64" />;
  if (error) return <ErrorNote>{errorMessage(error)}</ErrorNote>;
  if (!data?.docker.available) return <DockerHelp error={data?.docker.error} />;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['updates'] });
  const check = async () => {
    setChecking(true);
    try {
      qc.setQueryData(['updates'], await api.post<UpdatesResponse>('/api/updates/check'));
    } catch (err) {
      toast.error('Could not check for updates', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };
  const update = async (a: AppUpdateView) => {
    if (a.self && !(await confirm({ title: 'Update AIO Arr?', message: 'AIO Arr restarts with the new version. This page reconnects after a few seconds.', confirmLabel: 'Update' }))) return;
    if (a.dependents?.length && !(await confirm({ title: `Update ${a.appName}?`, message: `${a.dependents.join(', ')} share its network and will be restarted too.`, confirmLabel: 'Update' }))) return;
    setBusy(a.id);
    try {
      await api.post(`/api/updates/${encodeURIComponent(a.id)}`);
      refresh();
    } catch (err) {
      toast.error(`Could not update ${a.appName}`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const updateAll = async (list: AppUpdateView[]) => {
    const ok = await confirm({
      title: `Update ${list.length} ${list.length === 1 ? 'app' : 'apps'}?`,
      message: (
        <>
          {list.map((a) => a.appName).join(', ')} will be updated one after another{list.some((a) => a.self) ? ' - AIO Arr last, it restarts at the end' : ''}.
        </>
      ),
      confirmLabel: 'Update all',
    });
    if (!ok) return;
    setBusy('all');
    try {
      await api.post('/api/updates/all');
      refresh();
    } catch (err) {
      toast.error('Could not start the updates', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // recent jobs, matched by container name (updating gives the container a new id)
  const jobFor = (a: AppUpdateView) => data.jobs.find((j) => j.name === a.name && (!j.finishedAt || Date.now() - Date.parse(j.finishedAt) < 15 * 60_000));
  // what needs you first: running updates, then available ones
  const rank = (a: AppUpdateView) => (running(jobFor(a)) ? 0 : a.state === 'available' ? 1 : 2);
  const sorted = data.apps.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
  const yours = sorted.filter((a) => a.app || a.connected);
  const others = sorted.filter((a) => !a.app && !a.connected);
  const available = data.apps.filter((a) => a.state === 'available' && !running(jobFor(a)));
  const anyRunning = data.jobs.some((j) => !j.finishedAt);
  const row = (a: AppUpdateView) => <AppRow key={a.id} a={a} job={jobFor(a)} busy={busy === a.id} onUpdate={() => void update(a)} />;

  return (
    <div className="max-w-4xl space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok/12 text-ok">
          <Container className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Docker {data.docker.version}</div>
          <div className="text-xs text-muted">
            {data.checkedAt ? `Checked ${relative(data.checkedAt)}` : 'Not checked yet'} · checked automatically twice a day
            {available.length ? ` · ${available.length} ${available.length === 1 ? 'update' : 'updates'} available` : ''}
          </div>
        </div>
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={checking} disabled={anyRunning} onClick={() => void check()}>
          Check now
        </Button>
        {available.length > 0 && (
          <Button size="sm" variant="primary" icon={ArrowUpCircle} loading={busy === 'all'} onClick={() => void updateAll(available)}>
            Update all ({available.length})
          </Button>
        )}
      </div>

      <div className="card divide-y divide-line">{yours.length ? yours.map(row) : <div className="p-6 text-center text-sm text-muted">No known apps found in Docker.</div>}</div>

      {others.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowOthers((v) => !v)} className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-fg">
            <ChevronDown className={clsx('size-3.5 transition-transform', !showOthers && '-rotate-90')} /> Other containers ({others.length})
          </button>
          {showOthers && <div className="card divide-y divide-line">{others.map(row)}</div>}
        </div>
      )}
      <p className="text-xs text-subtle">
        Only images from a registry can be updated. Pinned versions (like <code className="font-mono">radarr:5.2.6</code>) stay on that version - use a tag like <code className="font-mono">latest</code> to get updates.
      </p>
    </div>
  );
}
