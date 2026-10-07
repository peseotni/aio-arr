/* Small TTL cache with in-flight de-duplication, so many browser tabs polling = one upstream call. */

interface Entry {
  value?: unknown;
  expires: number;
  pending?: Promise<unknown>;
}

const store = new Map<string, Entry>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit) {
    if (hit.pending) return hit.pending as Promise<T>;
    if (hit.expires > now) return hit.value as T;
  }
  const pending = fn().then(
    (value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    (err) => {
      store.delete(key);
      throw err;
    },
  );
  store.set(key, { expires: 0, pending });
  return pending;
}

/** Remove every entry whose key starts with one of the prefixes. */
export function invalidate(...prefixes: string[]): void {
  for (const key of store.keys()) {
    if (prefixes.some((p) => key.startsWith(p))) store.delete(key);
  }
}

export function clearCache(): void {
  store.clear();
}

/** Simple LRU-ish map with max size and TTL, for things like search results. */
export class TtlMap<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 2000,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, v: V): void {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
  }
}
