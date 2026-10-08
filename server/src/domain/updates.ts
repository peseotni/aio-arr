/*
 * One-click updates for the apps in your stack: compares every container's image with its registry,
 * pulls the new image and recreates the container (see recreate.ts). Needs access to Docker.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { CLIENT_IDS, SERVICE_IDS, getSettings } from '../config.js';
import { moduleLogger } from '../log.js';
import { JsonStore } from '../store.js';
import { VERSION } from '../version.js';
import { HttpError } from '../util/http.js';
import { invalidate } from '../util/cache.js';
import { DockerError, docker, type DockerClient } from '../services/docker.js';
import type { AppUpdateView, UpdateJobView, UpdateState, UpdatesResponse } from '../types.js';
import { dependentsOf, imageDefaults, recreateContainer } from './recreate.js';
import { serviceStatus } from './overview.js';

const log = moduleLogger('updates');

type Raw = Record<string, any>;

/** image name pattern -> app id + display name */
const KNOWN_APPS: [RegExp, string, string][] = [
  [/(^|\/)radarr/i, 'radarr', 'Radarr'],
  [/(^|\/)sonarr/i, 'sonarr', 'Sonarr'],
  [/(^|\/)lidarr/i, 'lidarr', 'Lidarr'],
  [/(^|\/)readarr/i, 'readarr', 'Readarr'],
  [/(^|\/)prowlarr/i, 'prowlarr', 'Prowlarr'],
  [/(^|\/)bazarr/i, 'bazarr', 'Bazarr'],
  [/(^|\/)jellyfin(:|$)/i, 'jellyfin', 'Jellyfin'],
  [/pms-docker|(^|\/)plex(:|$)/i, 'plex', 'Plex'],
  [/embyserver|(^|\/)emby(:|$)/i, 'emby', 'Emby'],
  [/(^|\/)navidrome/i, 'navidrome', 'Navidrome'],
  [/(^|\/)audiobookshelf/i, 'audiobookshelf', 'Audiobookshelf'],
  [/(^|\/)komga/i, 'komga', 'Komga'],
  [/(^|\/)kavita/i, 'kavita', 'Kavita'],
  [/jellyseerr/i, 'jellyseerr', 'Jellyseerr'],
  [/overseerr/i, 'jellyseerr', 'Overseerr'],
  [/(^|\/)qbittorrent/i, 'qbittorrent', 'qBittorrent'],
  [/(^|\/)transmission/i, 'transmission', 'Transmission'],
  [/(^|\/)deluge/i, 'deluge', 'Deluge'],
  [/(^|\/)sabnzbd/i, 'sabnzbd', 'SABnzbd'],
  [/(^|\/)nzbget/i, 'nzbget', 'NZBGet'],
  [/(^|\/)aio-arr/i, 'aio-arr', 'AIO Arr'],
  [/gluetun/i, 'gluetun', 'Gluetun (VPN)'],
  [/flaresolverr/i, 'flaresolverr', 'FlareSolverr'],
  [/unpackerr/i, 'unpackerr', 'Unpackerr'],
  [/recyclarr/i, 'recyclarr', 'Recyclarr'],
  [/(^|\/)jackett/i, 'jackett', 'Jackett'],
  [/(^|\/)autobrr/i, 'autobrr', 'autobrr'],
  [/(^|\/)tdarr/i, 'tdarr', 'Tdarr'],
  [/(^|\/)tautulli/i, 'tautulli', 'Tautulli'],
  [/(^|\/)mylar3?/i, 'mylar', 'Mylar3'],
  [/kapowarr/i, 'kapowarr', 'Kapowarr'],
  [/calibre-web/i, 'calibre-web', 'Calibre-Web'],
  [/(^|\/)calibre(:|$)/i, 'calibre', 'Calibre'],
  [/(^|\/)homepage/i, 'homepage', 'Homepage'],
  [/(^|\/)homarr/i, 'homarr', 'Homarr'],
  [/cross-seed/i, 'cross-seed', 'cross-seed'],
  [/(^|\/)caddy(:|$)/i, 'caddy', 'Caddy'],
  [/(^|\/)traefik/i, 'traefik', 'Traefik'],
  [/nginx-proxy-manager/i, 'npm', 'Nginx Proxy Manager'],
  [/(^|\/)swag(:|$)/i, 'swag', 'SWAG'],
  [/cloudflared/i, 'cloudflared', 'Cloudflare Tunnel'],
  [/watchtower/i, 'watchtower', 'Watchtower'],
];

export function identifyApp(image: string, name: string): { app?: string; appName: string } {
  for (const [re, app, appName] of KNOWN_APPS) if (re.test(image)) return { app, appName };
  for (const [re, app, appName] of KNOWN_APPS) if (re.test(`/${name}`)) return { app, appName };
  return { appName: name };
}

/** Configured URL of an app AIO Arr is connected to. */
function connectedUrl(app: string): URL | undefined {
  const s = getSettings();
  const cfg = (SERVICE_IDS as readonly string[]).includes(app)
    ? s.services[app as keyof typeof s.services]
    : (CLIENT_IDS as readonly string[]).includes(app)
      ? s.clients[app as keyof typeof s.clients]
      : undefined;
  if (!cfg?.enabled || !cfg.url) return undefined;
  try {
    return new URL(cfg.url);
  } catch {
    return undefined;
  }
}

/** Which containers are the apps AIO Arr talks to (by host name, compose service, published port or VPN container). */
function connectedContainers(list: Raw[], appOf: (c: Raw) => string | undefined): Set<string> {
  const out = new Set<string>();
  const nameOf = (c: Raw) => String(c.Names?.[0] || '').replace(/^\//, '');
  const byId = new Map(list.map((c) => [String(c.Id), c]));
  const apps = new Set(list.map(appOf).filter((a): a is string => !!a));
  for (const app of apps) {
    const url = connectedUrl(app);
    if (!url) continue;
    const host = url.hostname.toLowerCase();
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const local = host === 'localhost' || host === 'host.docker.internal' || /^[\d.]+$/.test(host) || host.includes(':');
    const mine = list.filter((c) => appOf(c) === app);
    const hit = mine.filter((c) => {
      if (nameOf(c).toLowerCase() === host || String(c.Labels?.['com.docker.compose.service'] || '').toLowerCase() === host) return true;
      if (local && ((c.Ports || []) as Raw[]).some((p) => p.PublicPort === port)) return true;
      // behind a VPN container: "http://gluetun:8080" reaches the app sharing gluetun's network
      const mode = String(c.HostConfig?.NetworkMode || '');
      if (mode.startsWith('container:')) {
        const owner = byId.get(mode.slice('container:'.length));
        if (owner && (nameOf(owner).toLowerCase() === host || String(owner.Labels?.['com.docker.compose.service'] || '').toLowerCase() === host)) return true;
      }
      return false;
    });
    for (const c of hit.length ? hit : mine.length === 1 ? mine : []) out.add(String(c.Id));
  }
  return out;
}

/** Our own container id (to update ourselves through a helper container). */
export function selfContainerId(): string | undefined {
  try {
    const m = /\/containers\/([0-9a-f]{64})\//.exec(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
    if (m) return m[1];
  } catch {
    /* not linux */
  }
  const h = os.hostname();
  return /^[0-9a-f]{12}$/.test(h) ? h : undefined;
}

function versionFromLabels(labels: Raw = {}): string | undefined {
  const v = /version:-\s*(\S+)/i.exec(labels.build_version || '')?.[1] || labels['org.opencontainers.image.version'];
  return v && String(v).length < 60 && !/^(latest|stable|develop|nightly)$/i.test(String(v)) ? String(v) : undefined;
}

/* ------------------------------------------------------------------ */
/* Update checks                                                       */
/* ------------------------------------------------------------------ */

interface Check {
  state: UpdateState;
  message?: string;
  checkedAt: string;
}

const checks = new Map<string, Check>();
let lastCheck: string | undefined;
let checking: Promise<void> | undefined;

/** Check results survive restarts (AIO Arr restarts when it updates itself). */
interface Saved {
  checks: Record<string, Check>;
  lastCheck?: string;
  /** set right before AIO Arr hands its own update to the helper container */
  selfUpdate?: { name: string; image: string; at: string };
  /** defaults of the images containers run (pulling a new version can remove the old image) */
  images?: Record<string, Raw>;
}
const saved = new JsonStore<Saved>('updates.json', () => ({ checks: {} }));
let loaded = false;

function loadChecks(): void {
  if (loaded) return;
  loaded = true;
  const s = saved.read();
  for (const [k, v] of Object.entries(s.checks || {})) checks.set(k, v);
  lastCheck = s.lastCheck;
}

function saveChecks(images?: Map<string, Raw>): void {
  saved.update((d) => {
    d.checks = Object.fromEntries(checks);
    d.lastCheck = lastCheck;
    if (images) d.images = Object.fromEntries(images);
  });
}

/** The old image's defaults: from Docker while it still has the image, else what we saw during the last check. */
async function oldImageDefaults(d: DockerClient, imageId: string): Promise<Raw | undefined> {
  const img = await d.image(imageId).catch(() => undefined);
  return imageDefaults(img?.Config) || saved.read().images?.[imageId];
}

/** Registry digests an image is known by. With Docker's containerd image store the id is the digest itself. */
const digestsOf = (img: Raw | undefined): string[] => [...((img?.RepoDigests || []) as string[]).map((x) => x.slice(x.indexOf('@') + 1)), ...(img?.Id ? [String(img.Id)] : [])];

/** Is there a newer image for this container? Compares what actually runs with the registry. */
async function checkContainer(d: DockerClient, ref: string, containerImageId: string, running: Raw | undefined): Promise<Check> {
  const now = new Date().toISOString();
  if (!ref || /^sha256:[0-9a-f]+$/.test(ref) || /^[0-9a-f]{12,64}$/.test(ref)) return { state: 'unknown', message: 'Started from an image id, not a name', checkedAt: now };
  const tagged = await d.image(ref).catch(() => undefined);
  const runningDigests = digestsOf(running);
  const pulled = (img: Raw | undefined) => !!img?.RepoDigests?.length;
  if (running && !pulled(running) && !pulled(tagged)) return { state: 'local', message: 'Built on this machine - rebuild it to update', checkedAt: now };
  try {
    const remote = await d.registryDigest(ref);
    if (!remote) return { state: 'unknown', message: 'The registry did not report a version', checkedAt: now };
    if (runningDigests.includes(remote)) return { state: 'up-to-date', checkedAt: now };
    const downloaded = tagged && tagged.Id !== containerImageId && digestsOf(tagged).includes(remote);
    return { state: 'available', message: downloaded ? 'The new version is already downloaded' : undefined, checkedAt: now };
  } catch (err) {
    const msg = (err as Error).message;
    return { state: 'error', message: /unauthorized|denied|authentication/i.test(msg) ? 'Private image - update it with docker compose pull' : msg.slice(0, 200), checkedAt: now };
  }
}

/** The image a container was created from ("lscr.io/linuxserver/radarr:latest"). The list shows an id once the tag moved on. */
async function imageRef(d: DockerClient, c: Raw): Promise<string> {
  const img = String(c.Image || '');
  if (!/^sha256:/.test(img)) return img;
  const info = await d.inspect(c.Id).catch(() => undefined);
  return String(info?.Config?.Image || img);
}

/** Check every container (a few at a time). */
export function checkForUpdates(): Promise<void> {
  const d = docker();
  if (!d) return Promise.resolve();
  if (!checking) {
    checking = (async () => {
      const list = await d.containers(true);
      const refs = await Promise.all(list.map(async (c) => ({ ref: await imageRef(d, c), id: String(c.ImageID) })));
      const queue = [...new Map(refs.map((r) => [`${r.ref}|${r.id}`, r])).values()];
      const fresh = new Map<string, Check>();
      const images = new Map<string, Raw>(Object.entries(saved.read().images || {}).filter(([id]) => refs.some((r) => r.id === id)));
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const running = await d.image(r.id).catch(() => undefined);
          const defaults = imageDefaults(running?.Config);
          if (defaults) images.set(r.id, defaults);
          fresh.set(`${r.ref}|${r.id}`, await checkContainer(d, r.ref, r.id, running));
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      // only what exists now (removed containers and replaced images drop out)
      checks.clear();
      for (const [k, v] of fresh) checks.set(k, v);
      lastCheck = new Date().toISOString();
      saveChecks(images);
      log.info(`Update check done: ${[...checks.values()].filter((c) => c.state === 'available').length} update(s) available`);
    })().finally(() => {
      checking = undefined;
    });
  }
  return checking;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, UpdateJobView>();
let chain: Promise<void> = Promise.resolve();

function finishJob(job: UpdateJobView, status: UpdateJobView['status'], message?: string): void {
  job.status = status;
  job.message = message;
  job.finishedAt = new Date().toISOString();
  // keep the list short
  const done = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!));
  for (const j of done.slice(20)) jobs.delete(j.id);
}

/** Queue an update; updates run one after another. */
export function startUpdate(containerId: string, name: string): UpdateJobView {
  const running = [...jobs.values()].find((j) => j.container === containerId && !j.finishedAt);
  if (running) return running;
  const job: UpdateJobView = { id: crypto.randomUUID(), container: containerId, name, status: 'queued', startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  chain = chain.then(() => runUpdate(job)).catch(() => undefined);
  return job;
}

async function runUpdate(job: UpdateJobView): Promise<void> {
  const d = docker();
  if (!d) return finishJob(job, 'failed', 'Docker is not available');
  try {
    const info = await d.inspect(job.container);
    const ref = String(info.Config?.Image || '');
    if (!ref || /^sha256:/.test(ref)) return finishJob(job, 'failed', 'This container was started from an image id - update it by hand');
    // before pulling: the pull can take the old image (and with it its defaults) away
    const oldDefaults = await oldImageDefaults(d, String(info.Image));
    job.status = 'pulling';
    job.message = `Downloading ${ref}`;
    await d.pull(ref, (s) => {
      if (/Downloading|Extracting|Pulling/.test(s)) job.message = s;
    });
    const img = await d.image(ref);
    const key = `${ref}|${info.Image}`;
    if (img.Id === info.Image) {
      checks.set(key, { state: 'up-to-date', checkedAt: new Date().toISOString() });
      saveChecks();
      return finishJob(job, 'up-to-date', 'Already up to date');
    }
    const selfId = selfContainerId();
    if (selfId && String(info.Id).startsWith(selfId)) {
      saved.update((s) => {
        s.selfUpdate = { name: job.name, image: img.Id, at: new Date().toISOString() };
      });
      await updateSelf(d, info, ref, img.Id, oldDefaults);
      job.status = 'recreating';
      job.message = 'AIO Arr restarts in a few seconds…';
      return; // the helper takes it from here, this process is about to be replaced
    }
    job.status = 'recreating';
    const dependents = await dependentsOf(d, info.Id);
    const res = await recreateContainer(d, info, ref, { onStep: (m) => (job.message = m), oldImageConfig: oldDefaults });
    // containers living in its network ("network_mode: service:gluetun") must follow it
    const problems: string[] = [];
    for (const dep of dependents) {
      const depName = String(dep.Names?.[0] || dep.Id).replace(/^\//, '');
      job.message = `Reconnecting ${depName}`;
      try {
        const depInfo = await d.inspect(dep.Id);
        await recreateContainer(d, depInfo, String(depInfo.Config?.Image), { networkMode: `container:${res.id}` });
      } catch (err) {
        problems.push(`${depName}: ${(err as Error).message}`);
      }
    }
    checks.delete(key);
    checks.set(`${ref}|${img.Id}`, { state: 'up-to-date', checkedAt: new Date().toISOString() });
    saveChecks();
    invalidate('status');
    if (problems.length) {
      finishJob(job, 'failed', `Updated, but could not reconnect ${problems.join('; ')} - restart it with docker compose up -d`);
      return;
    }
    finishJob(job, 'done', res.note || 'Updated');
    log.info(`Updated ${job.name} (${ref})`);
  } catch (err) {
    const msg = err instanceof DockerError || err instanceof Error ? err.message : String(err);
    log.warn(`Updating ${job.name} failed: ${msg}`);
    finishJob(job, 'failed', msg);
  }
}

/** We cannot replace our own container from inside it: start a short-lived helper from the new image to do it. */
async function updateSelf(d: DockerClient, info: Raw, ref: string, imageId: string, oldDefaults: Raw | undefined): Promise<void> {
  const binds: string[] = [];
  const sock = ((info.Mounts || []) as Raw[]).find((m) => m.Destination === '/var/run/docker.sock');
  if (sock?.Source) binds.push(`${sock.Source}:/var/run/docker.sock`);
  const env = process.env.DOCKER_HOST ? [`DOCKER_HOST=${process.env.DOCKER_HOST}`] : [];
  const mode = String(info.HostConfig?.NetworkMode || 'default');
  const helper = await d.create(`aio-arr-updater-${Date.now()}`, {
    Image: imageId,
    Entrypoint: ['node'],
    Cmd: ['dist/updater.js', info.Id, ref, Buffer.from(JSON.stringify(oldDefaults || {})).toString('base64')],
    Env: env,
    Labels: { 'aio-arr.updater': 'true' },
    HostConfig: { AutoRemove: true, Binds: binds, NetworkMode: mode.startsWith('container:') ? 'default' : mode },
  });
  await d.start(helper.Id);
  log.info('Self-update handed over to a helper container');
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export async function updatesOverview(): Promise<UpdatesResponse> {
  loadChecks();
  const d = docker();
  const jobList = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!d) {
    return { docker: { available: false, error: 'AIO Arr has no access to Docker' }, apps: [], jobs: jobList };
  }
  let version: Raw;
  let list: Raw[];
  try {
    [version, list] = await Promise.all([d.version(), d.containers(true)]);
  } catch (err) {
    return { docker: { available: false, error: (err as Error).message }, apps: [], jobs: jobList };
  }
  const selfId = selfContainerId();
  // versions as the apps report them (more reliable than image labels)
  const reported = new Map<string, string>();
  try {
    for (const sv of (await serviceStatus()).services) if (sv.version) reported.set(sv.id, sv.version);
  } catch {
    /* status unavailable */
  }
  const refs = new Map(await Promise.all(list.map(async (c) => [String(c.Id), await imageRef(d, c)] as const)));
  const appOf = (c: Raw) => identifyApp(refs.get(String(c.Id)) || String(c.Image), String(c.Names?.[0] || '').replace(/^\//, '')).app;
  const connectedIds = connectedContainers(list, appOf);
  const byNetworkOwner = new Map<string, string[]>();
  for (const c of list) {
    const mode = String(c.HostConfig?.NetworkMode || '');
    if (mode.startsWith('container:')) {
      const owner = mode.slice('container:'.length);
      byNetworkOwner.set(owner, [...(byNetworkOwner.get(owner) || []), String(c.Names?.[0] || '').replace(/^\//, '')]);
    }
  }
  const apps: AppUpdateView[] = list
    .filter((c) => c.Labels?.['aio-arr.updater'] !== 'true' && !/-aio-old$/.test(String(c.Names?.[0] || '')))
    .map((c) => {
      const name = String(c.Names?.[0] || c.Id).replace(/^\//, '');
      const ref = refs.get(String(c.Id)) || String(c.Image);
      const { app, appName } = identifyApp(ref, name);
      const check = checks.get(`${ref}|${c.ImageID}`);
      const connected = connectedIds.has(String(c.Id));
      return {
        id: c.Id,
        name,
        app,
        appName,
        image: ref,
        version: (connected && app && reported.get(app)) || versionFromLabels(c.Labels),
        connected,
        running: c.State === 'running',
        state: check?.state ?? 'unknown',
        message: check?.message,
        checkedAt: check?.checkedAt,
        dependents: byNetworkOwner.get(c.Id),
        self: !!selfId && String(c.Id).startsWith(selfId),
      };
    })
    .sort((a, b) => Number(!!b.app) - Number(!!a.app) || Number(b.connected) - Number(a.connected) || a.appName.localeCompare(b.appName));
  return { docker: { available: true, version: version.Version }, apps, checkedAt: lastCheck, jobs: jobList };
}

export function updateJob(id: string): UpdateJobView {
  const j = jobs.get(id);
  if (!j) throw new HttpError('Update job not found', 404);
  return j;
}

let timer: NodeJS.Timeout | undefined;

/** Did the self-update we started before the restart go through? Shown as a finished job. */
async function selfUpdateResult(d: DockerClient): Promise<boolean> {
  const s = saved.read().selfUpdate;
  if (!s) return false;
  saved.update((x) => {
    delete x.selfUpdate;
  });
  if (Date.now() - Date.parse(s.at) > 30 * 60_000) return false;
  const selfId = selfContainerId();
  const me = selfId ? await d.inspect(selfId).catch(() => undefined) : undefined;
  const ok = !!me && me.Image === s.image;
  const job: UpdateJobView = {
    id: crypto.randomUUID(),
    container: String(me?.Id || ''),
    name: s.name,
    status: ok ? 'done' : 'failed',
    message: ok ? `Updated to v${VERSION.replace(/^v/, '')}` : 'The update did not finish - AIO Arr is still on the old version',
    startedAt: s.at,
    finishedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  log.info(ok ? `AIO Arr updated itself to ${VERSION}` : 'The self-update did not finish');
  return ok;
}

/** Look for updates shortly after start and then twice a day. */
export function startUpdateChecker(): void {
  const d = docker();
  if (timer || !d) return;
  loadChecks();
  const run = () => void checkForUpdates().catch((err) => log.debug('update check failed', (err as Error).message));
  // right after updating itself: check again soon, so the list is current
  void selfUpdateResult(d)
    .catch(() => false)
    .then((justUpdated) => setTimeout(run, justUpdated ? 10_000 : 2 * 60 * 1000).unref());
  timer = setInterval(run, 12 * 60 * 60 * 1000);
  timer.unref();
}
