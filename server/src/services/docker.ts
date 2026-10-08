/*
 * Minimal Docker Engine API client (unix socket or DOCKER_HOST=tcp://...), used for one-click app updates.
 * Only enabled when the socket is mounted into the container (or DOCKER_HOST points to a socket proxy).
 */
import fs from 'node:fs';
import http from 'node:http';

type Raw = Record<string, any>;

export interface DockerTarget {
  socketPath?: string;
  host?: string;
  port?: number;
}

export const DEFAULT_SOCKET = '/var/run/docker.sock';

/** Where the Docker API is, if it is reachable from here at all. */
export function dockerTarget(env: NodeJS.ProcessEnv = process.env): DockerTarget | undefined {
  const dh = (env.DOCKER_HOST || '').trim();
  if (dh) {
    if (dh.startsWith('unix://')) return { socketPath: dh.slice('unix://'.length) };
    if (/^(tcp|http):\/\//.test(dh)) {
      const u = new URL(dh.replace(/^tcp:/, 'http:'));
      return { host: u.hostname, port: Number(u.port) || 2375 };
    }
    return undefined; // https / ssh need certificates or a CLI - not supported
  }
  try {
    return fs.statSync(DEFAULT_SOCKET).isSocket() ? { socketPath: DEFAULT_SOCKET } : undefined;
  } catch {
    return undefined;
  }
}

export class DockerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

interface ReqOpts {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** stream: called for every JSON line (image pulls report progress this way) */
  onLine?: (line: Raw) => void;
}

/** We talk a fixed API version within what the daemon supports, so responses look the same everywhere. */
const PREFERRED_API = 1.43;

export class DockerClient {
  private apiPrefix?: string;

  constructor(private readonly target: DockerTarget) {}

  private raw(method: string, path: string, opts: ReqOpts = {}): Promise<{ status: number; body: string }> {
    const qs = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...(this.target.socketPath ? { socketPath: this.target.socketPath } : { host: this.target.host, port: this.target.port }),
          method,
          path: `${path}${qs ? `?${qs}` : ''}`,
          headers: {
            Host: 'docker',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
            ...opts.headers,
          },
        },
        (res) => {
          let body = '';
          let pending = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (opts.onLine && (res.statusCode || 0) < 400) {
              pending += chunk;
              const lines = pending.split('\n');
              pending = lines.pop() || '';
              for (const l of lines) {
                if (!l.trim()) continue;
                try {
                  opts.onLine(JSON.parse(l));
                } catch {
                  /* partial line */
                }
              }
            }
            body += chunk;
          });
          res.on('end', () => {
            if (opts.onLine && pending.trim()) {
              try {
                opts.onLine(JSON.parse(pending));
              } catch {
                /* ignore */
              }
            }
            resolve({ status: res.statusCode || 0, body });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(opts.timeoutMs ?? 30000, () => req.destroy(new Error('Docker did not answer in time')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES') reject(new DockerError('No permission to use the Docker socket (it must be readable by the AIO Arr user - see README)', 403));
        else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new DockerError('Docker is not reachable (is the socket mounted?)', 503));
        else reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async prefix(): Promise<string> {
    if (this.apiPrefix) return this.apiPrefix;
    const r = await this.raw('GET', '/version', { timeoutMs: 10000 });
    if (r.status >= 400) throw new DockerError(`Docker: HTTP ${r.status}`, r.status);
    const v = JSON.parse(r.body) as Raw;
    const max = Number(v.ApiVersion) || PREFERRED_API;
    const min = Number(v.MinAPIVersion) || 1.24;
    const use = Math.max(min, Math.min(max, PREFERRED_API));
    this.apiPrefix = `/v${use.toFixed(2)}`;
    return this.apiPrefix;
  }

  async request<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
    const r = await this.raw(method, `${await this.prefix()}${path}`, opts);
    let data: unknown = undefined;
    if (r.body && !opts.onLine) {
      try {
        data = JSON.parse(r.body);
      } catch {
        data = r.body;
      }
    }
    if (r.status >= 400) {
      const msg = data && typeof data === 'object' && 'message' in data ? String((data as Raw).message) : r.body.slice(0, 300) || `HTTP ${r.status}`;
      throw new DockerError(msg, r.status);
    }
    return data as T;
  }

  version(): Promise<Raw> {
    return this.request('GET', '/version', { timeoutMs: 10000 });
  }

  containers(all = false): Promise<Raw[]> {
    return this.request('GET', '/containers/json', { query: { all } });
  }

  inspect(id: string): Promise<Raw> {
    return this.request('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  image(ref: string): Promise<Raw> {
    return this.request('GET', `/images/${ref}/json`);
  }

  /** Digest of the image currently published in its registry (the daemon handles registry auth). */
  async registryDigest(ref: string): Promise<string | undefined> {
    const r = await this.request<Raw>('GET', `/distribution/${ref}/json`, { timeoutMs: 30000 });
    return r?.Descriptor?.digest;
  }

  /** docker pull - resolves when done, throws on errors reported in the progress stream. */
  async pull(ref: string, onProgress?: (status: string) => void): Promise<void> {
    const { name, tag } = splitRef(ref);
    let error: string | undefined;
    await this.request('POST', '/images/create', {
      query: { fromImage: name, tag },
      // the daemon does not use your docker CLI login: send an empty auth, fine for public images
      headers: { 'X-Registry-Auth': Buffer.from('{}').toString('base64') },
      timeoutMs: 30 * 60 * 1000,
      onLine: (l) => {
        if (l.error) error = String(l.error);
        else if (l.status && onProgress) onProgress(String(l.status));
      },
    });
    if (error) throw new DockerError(error, 500);
  }

  create(name: string, config: Raw): Promise<{ Id: string; Warnings?: string[] }> {
    return this.request('POST', '/containers/create', { query: { name }, body: config, timeoutMs: 60000 });
  }

  start(id: string): Promise<void> {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/start`, { timeoutMs: 60000 });
  }

  stop(id: string, seconds = 30): Promise<void> {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/stop`, { query: { t: seconds }, timeoutMs: (seconds + 30) * 1000 });
  }

  rename(id: string, name: string): Promise<void> {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/rename`, { query: { name } });
  }

  remove(id: string, force = false): Promise<void> {
    // never remove volumes: anonymous volumes are handed over to the new container
    return this.request('DELETE', `/containers/${encodeURIComponent(id)}`, { query: { force, v: false } });
  }

  /** Delete an image (refused by docker while something still uses or tags it). */
  removeImage(id: string): Promise<void> {
    return this.request('DELETE', `/images/${encodeURIComponent(id)}`);
  }

  connect(network: string, container: string, endpoint: Raw): Promise<void> {
    return this.request('POST', `/networks/${encodeURIComponent(network)}/connect`, { body: { Container: container, EndpointConfig: endpoint } });
  }
}

/** "lscr.io/linuxserver/radarr:latest" -> name + tag (digest references keep the digest as tag). */
export function splitRef(ref: string): { name: string; tag: string } {
  const at = ref.indexOf('@');
  if (at > 0) return { name: ref.slice(0, at), tag: ref.slice(at + 1) };
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: 'latest' };
}

let client: DockerClient | undefined;
let clientKey = '';

/** Shared client, or undefined when Docker is not available. */
export function docker(): DockerClient | undefined {
  const t = dockerTarget();
  if (!t) return undefined;
  const key = JSON.stringify(t);
  if (!client || key !== clientKey) {
    client = new DockerClient(t);
    clientKey = key;
  }
  return client;
}
