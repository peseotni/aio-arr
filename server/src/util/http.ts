/* fetch wrapper used by every integration: timeouts, query building, friendly errors. */

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Error talking to an upstream service (Radarr, qBittorrent, ...). */
export class ServiceError extends HttpError {
  constructor(
    message: string,
    public readonly service: string,
    public readonly upstreamStatus?: number,
    details?: unknown,
  ) {
    super(message, upstreamStatus === 401 || upstreamStatus === 403 ? 502 : upstreamStatus === 404 ? 404 : 502, details);
    this.name = 'ServiceError';
  }
}

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export interface RequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  /** Objects are JSON encoded; FormData / URLSearchParams / Buffer / string are sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  responseType?: 'json' | 'text' | 'buffer' | 'raw';
  /** Follow redirects (default true). */
  redirect?: 'follow' | 'manual';
  /** Accept these non-2xx statuses without throwing (raw/text handling by caller). */
  okStatuses?: number[];
}

export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!path) return base.replace(/\/+$/, '');
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const NETWORK_HINTS: Record<string, string> = {
  ECONNREFUSED: 'connection refused - is the service running and is the port right?',
  ENOTFOUND: 'host not found - check the hostname (containers must share a docker network)',
  EAI_AGAIN: 'DNS lookup failed - check the hostname',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection was reset',
  EHOSTUNREACH: 'host unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'service did not respond in time',
  UND_ERR_SOCKET: 'socket error',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate - use the http:// internal address instead',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate - use the http:// internal address instead',
};

function networkMessage(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'request timed out';
  const code = e?.cause?.code || e?.code;
  if (code && NETWORK_HINTS[code]) return `${NETWORK_HINTS[code]} (${code})`;
  return e?.cause?.message || e?.message || 'network error';
}

function firstSentences(s: string): string {
  const oneLine = s.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

/** Pull a human readable message out of the various error formats used by the *arr apps & friends. */
export function extractErrorMessage(body: string, status: number): string {
  const text = body?.trim();
  if (!text) return `HTTP ${status}`;
  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) {
      // *arr validation errors
      const msgs = data
        .map((d) => (d && typeof d === 'object' ? ((d as Record<string, unknown>).errorMessage as string) : ''))
        .filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const msg = d.message || d.error || d.detail || d.title || d.errorMessage;
      if (typeof msg === 'string' && msg) {
        // *arr apps put .NET stack traces into "description" - keep only a short, human part
        const raw = typeof d.description === 'string' ? d.description : '';
        const isTrace = /--->|\n\s+at |Exception:/.test(raw);
        const desc = raw && !isTrace && raw !== msg ? `: ${raw}` : '';
        return firstSentences(`${msg}${desc}`);
      }
      if (msg && typeof msg === 'object' && typeof (msg as Record<string, unknown>).message === 'string') {
        return (msg as Record<string, string>).message;
      }
    }
  } catch {
    /* not JSON */
  }
  // strip html (scripts and styles entirely)
  const plain = text
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 300) || `HTTP ${status}`;
}

export interface HttpTarget {
  name: string;
  baseUrl: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

export async function httpRequest<T = unknown>(target: HttpTarget, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = joinUrl(target.baseUrl, path) + buildQuery(opts.query);
  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', ...(await target.headers?.()), ...opts.headers };
  let body: RequestInit['body'] | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (
      typeof opts.body === 'string' ||
      opts.body instanceof URLSearchParams ||
      opts.body instanceof FormData ||
      opts.body instanceof Uint8Array ||
      opts.body instanceof ArrayBuffer
    ) {
      body = opts.body as RequestInit['body'];
    } else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || (body ? 'POST' : 'GET'),
      headers,
      body,
      redirect: opts.redirect || 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    });
  } catch (err) {
    throw new ServiceError(`${target.name}: ${networkMessage(err)}`, target.name);
  }

  if (opts.responseType === 'raw') return res as T;
  const okStatus = res.ok || (opts.okStatuses?.includes(res.status) ?? false);
  if (!okStatus) {
    const text = await res.text().catch(() => '');
    let msg = extractErrorMessage(text, res.status);
    // an HTML login page says nothing useful
    if (res.status === 401) msg = /^\s*</.test(text) ? 'unauthorized - check the API key / credentials' : `unauthorized - check the API key / credentials (${msg})`;
    throw new ServiceError(`${target.name}: ${msg}`, target.name, res.status, text.slice(0, 2000));
  }
  if (opts.responseType === 'buffer') return Buffer.from(await res.arrayBuffer()) as T;
  const text = await res.text();
  if (opts.responseType === 'text') return text as T;
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some endpoints answer with plain text even if JSON was requested
    if (/^\s*</.test(text)) {
      throw new ServiceError(
        `${target.name}: expected JSON but got HTML - is the URL right (and does it include the URL base)?`,
        target.name,
        res.status,
      );
    }
    return text as T;
  }
}
