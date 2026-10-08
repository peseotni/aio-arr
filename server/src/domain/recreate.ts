/*
 * Recreate a container on a new image, keeping everything you configured - like `docker compose up -d`
 * after a pull, or Watchtower. Safe by design:
 *   - only settings that differ from the OLD image's defaults are copied (the new image brings its own),
 *   - anonymous volumes (data of an image VOLUME you did not mount) are handed over, never deleted,
 *   - every network, alias and fixed IP is kept,
 *   - the old container is only removed once the new one runs (and is healthy, if it has a health check);
 *     otherwise the old one is put back.
 * No settings / config imports here: the self-update helper container runs this file on its own.
 */
import type { DockerClient } from '../services/docker.js';

type Raw = Record<string, any>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The parts of an image's config a container inherits (what createConfig compares against). */
export function imageDefaults(cfg: Raw | undefined): Raw | undefined {
  if (!cfg) return undefined;
  const { Env, Cmd, Entrypoint, Labels, ExposedPorts, Volumes, WorkingDir, User, StopSignal, Healthcheck } = cfg;
  return { Env, Cmd, Entrypoint, Labels, ExposedPorts, Volumes, WorkingDir, User, StopSignal, Healthcheck };
}

/** Variables an image owns (they change between versions); a container rarely sets them itself. */
const IMAGE_OWNED_ENV = /^(PATH|HOME|LANG|LANGUAGE|LC_[A-Z]+|[A-Z0-9_]*VERSION)$/;

/**
 * When the old image is already gone (its tag moved to the new one) we cannot tell which settings came from
 * it. Best guess: version-like variables, labels, ports and volumes the new image defines belong to the image;
 * everything else was set for the container and is kept.
 */
export function guessOldDefaults(container: Raw, newImage: Raw | undefined): Raw {
  const newEnv = new Set(((newImage?.Env || []) as string[]).map((e) => e.split('=')[0]));
  return {
    Env: ((container.Env || []) as string[]).filter((e) => {
      const k = e.split('=')[0];
      return newEnv.has(k) && IMAGE_OWNED_ENV.test(k);
    }),
    Labels: Object.fromEntries(Object.entries((container.Labels || {}) as Raw).filter(([k]) => k in ((newImage?.Labels || {}) as Raw))),
    ExposedPorts: newImage?.ExposedPorts,
    Volumes: newImage?.Volumes,
  };
}

/** Container create body from an inspected container. */
export function createConfig(info: Raw, imageRef: string, oldImageConfig: Raw | undefined, newImageId?: string): Raw {
  const c: Raw = structuredClone(info.Config || {});
  const img: Raw = oldImageConfig || {};
  c.Image = imageRef;
  // docker sets the hostname to the short container id unless you chose one
  if (c.Hostname && String(info.Id || '').startsWith(c.Hostname)) delete c.Hostname;
  if (!c.Domainname) delete c.Domainname;
  if (same(c.Cmd, img.Cmd)) delete c.Cmd;
  if (same(c.Entrypoint, img.Entrypoint)) delete c.Entrypoint;
  if (same(c.Healthcheck, img.Healthcheck)) delete c.Healthcheck;
  if (c.WorkingDir === img.WorkingDir) delete c.WorkingDir;
  if (c.User === img.User) delete c.User;
  if (c.StopSignal === img.StopSignal) delete c.StopSignal;
  const imageEnv = new Set<string>(img.Env || []);
  c.Env = (c.Env || []).filter((e: string) => !imageEnv.has(e));
  const imageLabels: Raw = img.Labels || {};
  c.Labels = Object.fromEntries(Object.entries(c.Labels || {}).filter(([k, v]) => imageLabels[k] !== v));
  if (newImageId && c.Labels['com.docker.compose.image']) c.Labels['com.docker.compose.image'] = newImageId;
  for (const k of Object.keys(img.ExposedPorts || {})) delete c.ExposedPorts?.[k];
  for (const k of Object.keys(img.Volumes || {})) delete c.Volumes?.[k];
  if (c.ExposedPorts && !Object.keys(c.ExposedPorts).length) delete c.ExposedPorts;
  if (c.Volumes && !Object.keys(c.Volumes).length) delete c.Volumes;
  delete c.MacAddress; // deprecated here; docker assigns a new one

  const hc: Raw = structuredClone(info.HostConfig || {});
  // sharing another container's network ("network_mode: service:gluetun"): docker refuses own hostname / ports here
  if (String(hc.NetworkMode || '').startsWith('container:')) {
    delete c.Hostname;
    delete c.Domainname;
    delete c.ExposedPorts;
  }
  // Keep anonymous volumes: without this the new container would start with an empty volume
  const target = (b: string) => {
    const parts = b.split(':');
    return parts.length >= 2 ? parts[1] : parts[0];
  };
  const covered = new Set<string>([...(hc.Binds || []).map(target), ...(hc.Mounts || []).map((m: Raw) => m.Target)]);
  for (const m of (info.Mounts || []) as Raw[]) {
    if (m.Type === 'volume' && m.Name && !covered.has(m.Destination)) {
      hc.Mounts = [...(hc.Mounts || []), { Type: 'volume', Source: m.Name, Target: m.Destination, ReadOnly: m.RW === false }];
      covered.add(m.Destination);
    }
  }
  return { ...c, HostConfig: hc };
}

export interface NetworkPlan {
  primary?: { name: string; endpoint: Raw };
  extra: { name: string; endpoint: Raw }[];
}

/** Which networks to attach at create time, and which to connect afterwards. */
export function networkPlan(info: Raw): NetworkPlan {
  const mode = String(info.HostConfig?.NetworkMode || 'default');
  if (mode === 'host' || mode === 'none' || mode.startsWith('container:')) return { extra: [] };
  const nets = Object.entries((info.NetworkSettings?.Networks || {}) as Record<string, Raw>);
  const endpoint = (name: string, e: Raw): Raw => {
    const out: Raw = {};
    if (name !== 'bridge') {
      // drop the alias docker adds for the short container id
      const aliases = ((e.Aliases || []) as string[]).filter((a) => !String(info.Id || '').startsWith(a));
      if (aliases.length) out.Aliases = aliases;
    }
    if (e.IPAMConfig && (e.IPAMConfig.IPv4Address || e.IPAMConfig.IPv6Address)) out.IPAMConfig = e.IPAMConfig;
    if (e.Links?.length) out.Links = e.Links;
    if (e.DriverOpts && Object.keys(e.DriverOpts).length) out.DriverOpts = e.DriverOpts;
    return out;
  };
  const primaryName = mode === 'default' ? 'bridge' : mode;
  const primary = nets.find(([n]) => n === primaryName) || nets[0];
  return {
    primary: primary ? { name: primary[0], endpoint: endpoint(primary[0], primary[1]) } : undefined,
    extra: nets.filter((n) => n !== primary).map(([name, e]) => ({ name, endpoint: endpoint(name, e) })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the container runs (and reports healthy if it has a health check). */
export async function waitHealthy(d: DockerClient, id: string, timeoutMs = 120_000): Promise<string | undefined> {
  const start = Date.now();
  let restarts = 0;
  let runningSince = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const st = (await d.inspect(id)).State || {};
    if (st.Status === 'exited' || st.Status === 'dead') throw new Error(`The new container stopped right away (exit code ${st.ExitCode}${st.Error ? `: ${st.Error}` : ''})`);
    if (st.Restarting) {
      if (++restarts >= 3) throw new Error('The new container keeps restarting');
      continue;
    }
    if (!st.Running) continue;
    runningSince ||= Date.now();
    const health = st.Health?.Status;
    if (health === 'healthy') return undefined;
    if (health === 'unhealthy') throw new Error('The new container reports itself unhealthy');
    if (!health && Date.now() - runningSince >= 6000) return undefined;
  }
  return 'Started - its health check has not finished yet';
}

export interface RecreateOptions {
  /** Point "network_mode: service:x" containers at the new network owner */
  networkMode?: string;
  onStep?: (msg: string) => void;
  /** The old image's defaults, read before pulling (pulling can remove the old image) */
  oldImageConfig?: Raw;
}

/** Replace a container by a new one from `imageRef`. Returns the new container id. */
export async function recreateContainer(d: DockerClient, info: Raw, imageRef: string, opts: RecreateOptions = {}): Promise<{ id: string; note?: string }> {
  const name = String(info.Name || '').replace(/^\//, '');
  const [oldImage, newImage] = await Promise.all([d.image(info.Image).catch(() => undefined), d.image(imageRef)]);
  const oldDefaults = opts.oldImageConfig || imageDefaults(oldImage?.Config) || guessOldDefaults(info.Config || {}, newImage?.Config);
  const config = createConfig(opts.networkMode ? { ...info, HostConfig: { ...info.HostConfig, NetworkMode: opts.networkMode } } : info, imageRef, oldDefaults, newImage?.Id);
  const plan = opts.networkMode ? { extra: [] } : networkPlan(info);
  if (plan.primary) config.NetworkingConfig = { EndpointsConfig: { [plan.primary.name]: plan.primary.endpoint } };
  const wasRunning = !!info.State?.Running;
  const backup = `${name}-aio-old`;

  // a leftover from an earlier failed attempt would block the rename
  try {
    const stale = await d.inspect(backup);
    if (stale?.Id && stale.Id !== info.Id) await d.remove(stale.Id, true);
  } catch {
    /* none */
  }
  opts.onStep?.('Stopping the old container');
  if (wasRunning) await d.stop(info.Id, Number(info.Config?.StopTimeout) || 30);
  await d.rename(info.Id, backup);
  let newId: string | undefined;
  try {
    opts.onStep?.('Creating the new container');
    newId = (await d.create(name, config)).Id;
    for (const n of plan.extra) await d.connect(n.name, newId, n.endpoint);
    let note: string | undefined;
    if (wasRunning) {
      opts.onStep?.('Starting');
      await d.start(newId);
      note = await waitHealthy(d, newId);
    }
    await d.remove(info.Id, true).catch(() => undefined);
    // the replaced image is now unused and untagged: free the disk space (docker refuses if anything still needs it)
    if (oldImage?.Id && oldImage.Id !== newImage?.Id) {
      const now = await d.image(oldImage.Id).catch(() => undefined);
      if (now && !(now.RepoTags || []).length) await d.removeImage(oldImage.Id).catch(() => undefined);
    }
    return { id: newId, note };
  } catch (err) {
    opts.onStep?.('Something went wrong - putting the old container back');
    if (newId) await d.remove(newId, true).catch(() => undefined);
    await d.rename(info.Id, name).catch(() => undefined);
    if (wasRunning) await d.start(info.Id).catch(() => undefined);
    throw err;
  }
}

/** Containers that live in another container's network ("network_mode: service:gluetun"). */
export async function dependentsOf(d: DockerClient, id: string): Promise<Raw[]> {
  const all = await d.containers(true);
  return all.filter((c) => c.HostConfig?.NetworkMode === `container:${id}`);
}
