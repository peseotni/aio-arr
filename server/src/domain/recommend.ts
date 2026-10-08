/*
 * Recommendations based on what you watched (Jellyfin / Emby history and favourites) and what you
 * downloaded recently (Radarr / Sonarr). Each of those "seeds" asks TMDB (with your free API key) or
 * Jellyseerr / Overseerr for similar titles; titles suggested by several seeds rank higher.
 * Without either, Radarr's own movie recommendations are used.
 */
import { SERVICE_NAMES } from '../config.js';
import { JsonStore } from '../store.js';
import { cached, invalidate } from '../util/cache.js';
import { HttpError } from '../util/http.js';
import { moduleLogger } from '../log.js';
import { services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { JRaw, JellyfinService } from '../services/jellyfin.js';
import type { RecItem, RecommendationSource } from '../services/discover.js';
import type { SessionUser } from '../auth.js';
import type { MediaItem, RecommendationSection, RecommendationsResponse } from '../types.js';
import { movieItem, seriesItem } from './media.js';
import { rawMovies, rawSeries } from './library.js';
import { titleScore } from './artwork.js';

const log = moduleLogger('recommend');

/** TMDB / Jellyseerr did not answer any lookup: show a fallback for now, but don't keep it for hours. */
class SourceDown extends Error {}
const downUntil = new Map<string, number>();

interface Seed {
  kind: 'movie' | 'series';
  tmdb?: number;
  tvdb?: number;
  imdb?: string;
  title: string;
  weight: number;
  why: 'watched' | 'favorite' | 'downloaded';
}

/* ------------------------------ dismissed ------------------------------ */

const store = new JsonStore<{ users: Record<string, { dismissed: string[] }> }>('recommendations.json', () => ({ users: {} }));

export function dismiss(username: string, key: string): void {
  if (!/^(movie|series):tmdb:\d+$/.test(key)) throw new HttpError('Invalid item', 400);
  store.update((d) => {
    const u = (d.users[username.toLowerCase()] ??= { dismissed: [] });
    if (!u.dismissed.includes(key)) u.dismissed = [key, ...u.dismissed].slice(0, 2000);
  });
  invalidate(`recs:${username.toLowerCase()}`);
}

const dismissed = (username: string) => new Set(store.read().users[username.toLowerCase()]?.dismissed || []);

/* ------------------------------ seeds ------------------------------ */

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** "Sintel (2010) [tmdbid-45745]" (unmatched items are named after their folder) -> "Sintel" */
const cleanTitle = (t: string) =>
  String(t || '')
    .replace(/\s*[[{][^\]}]*[\]}]/g, '')
    .replace(/\s*\((19|20)\d{2}\)\s*$/, '')
    .trim();

function fromJellyfin(i: JRaw, weight: number, why: Seed['why']): Seed | undefined {
  const kind = i.Type === 'Movie' ? 'movie' : i.Type === 'Series' ? 'series' : undefined;
  if (!kind) return undefined;
  const p = (i.ProviderIds || {}) as Record<string, string>;
  return { kind, tmdb: num(p.Tmdb), tvdb: num(p.Tvdb), imdb: p.Imdb || undefined, title: cleanTitle(i.Name), weight, why };
}

async function watchSeeds(user: SessionUser): Promise<Seed[]> {
  const reg = services();
  const jf = (reg.jellyfin || reg.emby) as JellyfinService | undefined;
  if (!jf) return [];
  const uid = await jf.homeUserId(user.source === 'jellyfin' ? user.jellyfinUserId : undefined);
  if (!uid) return [];
  const hist = await cached(`recs-hist:${uid}`, 30 * 60_000, () => jf.watchHistory(uid, 20));
  const seeds: Seed[] = [];
  hist.favorites.forEach((i) => {
    const s = fromJellyfin(i, 4, 'favorite');
    if (s) seeds.push(s);
  });
  hist.played.forEach((i, idx) => {
    // the more recent, the more it counts
    const s = fromJellyfin(i, 3 / (1 + idx * 0.15), 'watched');
    if (s) seeds.push(s);
  });
  return seeds;
}

async function downloadSeeds(): Promise<Seed[]> {
  const reg = services();
  const seeds: Seed[] = [];
  const recent = (list: Raw[]) => [...list].filter((x) => x.added).sort((a, b) => String(b.added).localeCompare(String(a.added)));
  if (reg.radarr) {
    const movies = recent(await rawMovies().catch(() => [] as Raw[])).filter((m) => m.hasFile || m.statistics?.movieFileCount);
    movies.slice(0, 8).forEach((m, i) => seeds.push({ kind: 'movie', tmdb: num(m.tmdbId), title: m.title, weight: 1.5 / (1 + i * 0.2), why: 'downloaded' }));
  }
  if (reg.sonarr) {
    const shows = recent(await rawSeries().catch(() => [] as Raw[])).filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0);
    shows.slice(0, 6).forEach((s, i) => seeds.push({ kind: 'series', tmdb: num(s.tmdbId), tvdb: num(s.tvdbId), title: s.title, weight: 1.5 / (1 + i * 0.2), why: 'downloaded' }));
  }
  return seeds;
}

/* ------------------------------ building ------------------------------ */

function toItem(r: RecItem, reason?: string): MediaItem {
  return {
    key: `${r.kind}:tmdb:${r.tmdbId}`,
    kind: r.kind,
    service: r.kind === 'movie' ? 'radarr' : 'sonarr',
    inLibrary: false,
    title: r.title,
    year: r.year,
    overview: r.overview,
    poster: r.poster,
    fanart: r.fanart,
    rating: r.rating,
    availability: 'none',
    ids: { tmdb: r.tmdbId },
    reason,
  };
}

interface Scored {
  rec: RecItem;
  score: number;
  because: Seed[];
}

async function personal(user: SessionUser, source: RecommendationSource): Promise<RecommendationsResponse> {
  const reg = services();
  const [watched, downloaded] = await Promise.all([watchSeeds(user).catch((err) => (log.debug('watch history unavailable', err.message), [] as Seed[])), downloadSeeds()]);
  // one seed per title, strongest reason wins
  const seeds = new Map<string, Seed>();
  for (const s of [...watched, ...downloaded]) {
    const k = `${s.kind}:${s.tmdb || s.tvdb || s.title}`;
    const prev = seeds.get(k);
    if (!prev) seeds.set(k, s);
    else prev.weight = Math.max(prev.weight, s.weight) + 0.5;
  }
  const list = [...seeds.values()].sort((a, b) => b.weight - a.weight).slice(0, 14);
  // titles your player knows only by TVDB / IMDb id: Radarr and Sonarr usually know the TMDB id
  const [libMovies, libShows] = await Promise.all([rawMovies().catch(() => [] as Raw[]), rawSeries().catch(() => [] as Raw[])]);
  for (const s of list) {
    if (s.tmdb) continue;
    const hit =
      s.kind === 'movie'
        ? libMovies.find((m) => s.imdb && m.imdbId === s.imdb)
        : libShows.find((x) => (s.tvdb && x.tvdbId === s.tvdb) || (s.imdb && x.imdbId === s.imdb));
    if (hit?.tmdbId) s.tmdb = Number(hit.tmdbId);
  }
  // still unknown shows: ask TMDB
  if (reg.tmdb) {
    await Promise.all(
      list.filter((s) => s.kind === 'series' && !s.tmdb && s.tvdb).map(async (s) => {
        s.tmdb = await reg.tmdb!.showByTvdb(s.tvdb!).catch(() => undefined);
      }),
    );
  }
  const usable = list.filter((s) => s.tmdb);
  const recsBySeed = new Map<Seed, RecItem[]>();
  const queue = [...usable];
  let failed = 0;
  let lastError = '';
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const recs = s.kind === 'movie' ? await source.movieRecommendations(s.tmdb!) : await source.tvRecommendations(s.tmdb!);
        recsBySeed.set(s, recs.slice(0, 20));
      } catch (err) {
        failed++;
        lastError = (err as Error).message;
        log.debug(`recommendations for "${s.title}" failed: ${lastError}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (usable.length && failed === usable.length) {
    log.warn(`${SERVICE_NAMES[source.id]} did not answer any recommendation request: ${lastError}`);
    throw new SourceDown(lastError);
  }

  // leave out what you already have, what you watched and what you dismissed
  const [movies, shows] = [libMovies, libShows];
  const have = new Set<string>([
    ...movies.map((m) => `movie:tmdb:${m.tmdbId}`),
    ...shows.filter((s) => s.tmdbId).map((s) => `series:tmdb:${s.tmdbId}`),
    ...usable.map((s) => `${s.kind}:tmdb:${s.tmdb}`),
    ...dismissed(user.username),
  ]);
  const showTitles = shows.map((s) => ({ title: String(s.title), year: Number(s.year) }));
  const owned = (r: RecItem) =>
    have.has(`${r.kind}:tmdb:${r.tmdbId}`) ||
    // shows in Sonarr without a TMDB id: compare names
    (r.kind === 'series' && showTitles.some((s) => titleScore(r.title, s.title) >= 0.95 && (!r.year || !s.year || Math.abs(s.year - r.year) <= 1)));

  const scored = new Map<string, Scored>();
  for (const [seed, recs] of recsBySeed) {
    recs.forEach((r, rank) => {
      if (owned(r)) return;
      const k = `${r.kind}:tmdb:${r.tmdbId}`;
      const e = scored.get(k) || { rec: r, score: 0, because: [] };
      e.score += seed.weight / Math.sqrt(rank + 1);
      e.because.push(seed);
      scored.set(k, e);
    });
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score || (b.rec.popularity || 0) - (a.rec.popularity || 0));
  const reasonOf = (e: Scored) => {
    const top = [...e.because].sort((a, b) => b.weight - a.weight)[0];
    if (!top) return undefined;
    const verb = top.why === 'downloaded' ? 'downloaded' : top.why === 'favorite' ? 'love' : 'watched';
    const more = e.because.length > 1 ? ` and ${e.because.length - 1} more` : '';
    return top.why === 'favorite' ? `Because you love ${top.title}${more}` : `Because you ${verb} ${top.title}${more}`;
  };

  const sections: RecommendationSection[] = [];
  if (ranked.length) {
    sections.push({ id: 'top', title: 'Top picks for you', subtitle: 'Based on what you watch and download', items: ranked.slice(0, 24).map((e) => toItem(e.rec, reasonOf(e))) });
  }
  const used = new Set(ranked.slice(0, 8).map((e) => `${e.rec.kind}:tmdb:${e.rec.tmdbId}`));
  const rows: { seed: Seed; title: string }[] = [
    ...usable.filter((s) => s.why !== 'downloaded').slice(0, 3).map((seed) => ({ seed, title: `Because you ${seed.why === 'favorite' ? 'love' : 'watched'} ${seed.title}` })),
    ...usable.filter((s) => s.why === 'downloaded').slice(0, 2).map((seed) => ({ seed, title: `Because you downloaded ${seed.title}` })),
  ];
  for (const { seed, title } of rows) {
    const recs = (recsBySeed.get(seed) || []).filter((r) => !owned(r));
    const fresh = recs.filter((r) => !used.has(`${r.kind}:tmdb:${r.tmdbId}`));
    if (fresh.length < 4) continue;
    sections.push({ id: `seed:${seed.kind}:${seed.tmdb}`, title, items: recs.slice(0, 18).map((r) => toItem(r)) });
    for (const r of fresh.slice(0, 6)) used.add(`${r.kind}:tmdb:${r.tmdbId}`);
  }
  const hints: string[] = [];
  if (!watched.length) {
    hints.push(reg.jellyfin || reg.emby ? 'Watch something in Jellyfin to get suggestions based on your history.' : 'Connect Jellyfin or Emby to get suggestions based on what you watch.');
  }
  if (!usable.length) hints.push('Add a few movies or shows (or watch something) and recommendations will appear here.');
  return { sections, sources: [source.id], hints };
}

/** Radarr's own recommendations (TMDB data through Radarr's servers): movies only. */
async function fromRadarr(user: SessionUser): Promise<RecommendationsResponse> {
  const reg = services();
  const hints = ['Add a free TMDB API key or connect Jellyseerr / Overseerr (Settings > Apps) for personal movie and TV recommendations based on what you watch.'];
  if (!reg.radarr) return { sections: [], sources: [], hints };
  const [list, lib] = await Promise.all([reg.radarr.discover(), rawMovies().catch(() => [] as Raw[])]);
  const skip = new Set([...lib.map((m) => `movie:tmdb:${m.tmdbId}`), ...dismissed(user.username)]);
  const seen = new Set<string>();
  const items = list
    .filter((m) => m.tmdbId && !m.isExcluded)
    .map((m) => ({ ...movieItem({ ...m, id: 0 }, { withRaw: true }) }))
    .filter((it) => !skip.has(it.key) && !seen.has(it.key) && seen.add(it.key))
    .slice(0, 30);
  return { sections: items.length ? [{ id: 'radarr', title: 'Recommended for your movie library', subtitle: 'Trending and similar to what you have, from Radarr', items }] : [], sources: ['radarr'], hints };
}

export async function recommendations(user: SessionUser): Promise<RecommendationsResponse> {
  const u = user.username.toLowerCase();
  const reg = services();
  const source: RecommendationSource | undefined = reg.tmdb || reg.jellyseerr;
  if (!source) return cached(`recs:${u}`, 3 * 60 * 60_000, () => fromRadarr(user));
  const down = (downUntil.get(u) || 0) > Date.now();
  try {
    if (down) throw new SourceDown('down');
    return await cached(`recs:${u}`, 3 * 60 * 60_000, async () => {
      const res = await personal(user, source);
      if (res.sections.length || !reg.radarr) return res;
      // nothing to go on yet: fall back to Radarr's list
      const fallback = await fromRadarr(user).catch(() => undefined);
      return fallback?.sections.length ? { ...fallback, hints: res.hints } : res;
    });
  } catch (err) {
    if (!(err instanceof SourceDown)) throw err;
    // ask again in a couple of minutes (errors are not cached)
    if (!down) downUntil.set(u, Date.now() + 2 * 60_000);
    const fallback = reg.radarr ? await cached(`recs-fallback:${u}`, 10 * 60_000, () => fromRadarr(user)).catch(() => undefined) : undefined;
    const name = SERVICE_NAMES[source.id];
    const hint = fallback?.sections.length ? `${name} is not answering right now, so these are Radarr's suggestions. Try Refresh in a few minutes.` : `${name} is not answering right now. Try Refresh in a few minutes.`;
    return { sections: fallback?.sections || [], sources: fallback?.sources || [], hints: [hint] };
  }
}

export function refreshRecommendations(user: SessionUser): void {
  const u = user.username.toLowerCase();
  downUntil.delete(u);
  invalidate(`recs:${u}`, `recs-fallback:${u}`, 'recs-hist:');
}

/* ------------------------------ add a recommended title ------------------------------ */

/** Turn a recommendation (TMDB id) into an addable Radarr / Sonarr item. */
export async function resolveItem(kind: 'movie' | 'series', ref: { tmdb?: number; tvdb?: number; title?: string; year?: number }): Promise<MediaItem> {
  const reg = services();
  if (kind === 'movie') {
    const radarr = reg.radarr;
    if (!radarr) throw new HttpError('Radarr is not configured. Add it under Settings.', 409);
    if (!ref.tmdb) throw new HttpError('Missing TMDB id', 400);
    const lib = (await rawMovies().catch(() => [] as Raw[])).find((m) => m.tmdbId === ref.tmdb);
    if (lib) return movieItem(lib);
    return movieItem(await radarr.lookupTmdb(ref.tmdb), { withRaw: true });
  }
  const sonarr = reg.sonarr;
  if (!sonarr) throw new HttpError('Sonarr is not configured. Add it under Settings.', 409);
  let tvdb = ref.tvdb;
  if (!tvdb && ref.tmdb) {
    const source = reg.tmdb || reg.jellyseerr;
    tvdb = await source?.tvdbForShow(ref.tmdb).catch(() => undefined);
  }
  const lib = await rawSeries().catch(() => [] as Raw[]);
  const inLib = lib.find((s) => (tvdb && s.tvdbId === tvdb) || (ref.tmdb && s.tmdbId === ref.tmdb));
  if (inLib) return seriesItem(inLib);
  let found: Raw | undefined;
  if (tvdb) found = (await sonarr.lookup(`tvdb:${tvdb}`))[0];
  if (!found && ref.title) {
    const results = await sonarr.lookup(ref.title);
    found =
      results.find((s) => ref.tmdb && s.tmdbId === ref.tmdb) ||
      results.find((s) => titleScore(ref.title!, s.title) >= 0.9 && (!ref.year || !s.year || Math.abs(s.year - ref.year) <= 1));
  }
  if (!found) throw new HttpError(`Sonarr could not find "${ref.title || ref.tmdb}"`, 404);
  return seriesItem(found, { withRaw: true });
}
