/*
 * Cover art for search results that do not come with a picture (indexer releases): your own *arr apps
 * first (they already reach TMDB / TVDB / MusicBrainz), then free public sources that need no key:
 * iTunes, Open Library, Google Books, Steam and Wikipedia. TMDB too if you added an API key.
 * A picture is only used when its title matches well enough; results are cached for a day.
 */
import { getSettings, type ContentType } from '../config.js';
import { TtlMap } from '../util/cache.js';
import { httpRequest } from '../util/http.js';
import { moduleLogger } from '../log.js';
import { services } from '../services/registry.js';
import type { Raw } from '../services/arr.js';
import type { ArtworkMatch } from '../types.js';
import { libraryArtwork, sizedRemote } from './media.js';
import { norm } from './parse.js';

const log = moduleLogger('artwork');

export interface ArtworkRequest {
  key: string;
  category: ContentType;
  title: string;
  year?: number;
  artist?: string;
  ids?: { imdb?: string; tmdb?: number; tvdb?: number };
}

const cache = new TtlMap<ArtworkMatch | null>(24 * 60 * 60 * 1000, 5000);

const UA = 'AIO-Arr/1.0 (+https://github.com/peseotni/aio-arr)';

function get<T = Raw>(name: string, base: string, path: string, query: Record<string, string | number | undefined>): Promise<T> {
  return httpRequest<T>({ name, baseUrl: base, headers: () => ({ 'User-Agent': UA, 'Api-User-Agent': UA }) }, path, { query, timeoutMs: 8000 });
}

/* ------------------------------ matching ------------------------------ */

const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));

/** "Saga, Vol. 1", "Hollow Knight (video game)" -> the title itself */
const bare = (s: string) =>
  norm(s.replace(/\s*\([^)]*\)\s*$/, ''))
    .replace(/\b(vol|volume|book|part|issue|tome|no)\s*\d+\b.*$/, '')
    .trim();

/** 0..1: how well two titles match (word overlap, exact match = 1). */
export function titleScore(a: string, b: string): number {
  const na = bare(a) || norm(a);
  const nb = bare(b) || norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(na);
  const tb = tokens(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  // "Dune Part Two" vs "Dune: Part Two" are equal after norm; "Saga" vs "Saga Vol 1" is a decent match
  const prefix = nb.startsWith(na) || na.startsWith(nb) ? 0.15 : 0;
  return Math.min(1, jaccard + prefix);
}

function best<T>(list: T[], want: ArtworkRequest, title: (x: T) => string | undefined, year?: (x: T) => number | undefined, min = 0.6): T | undefined {
  let top: T | undefined;
  let topScore = 0;
  for (const x of list) {
    const t = title(x);
    if (!t) continue;
    let s = titleScore(want.title, t);
    const y = year?.(x);
    if (want.year && y) s += y === want.year ? 0.1 : Math.abs(y - want.year) <= 1 ? 0 : -0.25;
    if (s > topScore) {
      top = x;
      topScore = s;
    }
  }
  return topScore >= min ? top : undefined;
}

const yearOf = (d?: string) => {
  const y = d ? Number(String(d).slice(0, 4)) : NaN;
  return y > 1000 ? y : undefined;
};

/* ------------------------------ sources ------------------------------ */

type Source = (r: ArtworkRequest) => Promise<ArtworkMatch | undefined>;

const radarr: Source = async (r) => {
  const svc = services().radarr;
  if (!svc) return undefined;
  const list: Raw[] = r.ids?.tmdb ? [await svc.lookupTmdb(r.ids.tmdb)] : await svc.lookup(r.ids?.imdb ? `imdb:${r.ids.imdb}` : `${r.title} ${r.year || ''}`.trim());
  const m = r.ids?.tmdb || r.ids?.imdb ? list[0] : best(list, r, (x) => x.title, (x) => x.year);
  if (!m) return undefined;
  const art = libraryArtwork('radarr', m);
  return art.poster ? { image: art.poster, source: 'radarr', title: m.title, year: m.year, overview: m.overview } : undefined;
};

const sonarr: Source = async (r) => {
  const svc = services().sonarr;
  if (!svc) return undefined;
  const list: Raw[] = await svc.lookup(r.ids?.tvdb ? `tvdb:${r.ids.tvdb}` : r.title);
  const m = r.ids?.tvdb ? list[0] : best(list, r, (x) => x.title, (x) => x.year);
  if (!m) return undefined;
  const art = libraryArtwork('sonarr', m);
  return art.poster ? { image: art.poster, source: 'sonarr', title: m.title, year: m.year, overview: m.overview } : undefined;
};

const lidarr: Source = async (r) => {
  const svc = services().lidarr;
  if (!svc) return undefined;
  const list: Raw[] = await svc.search([r.artist, r.title].filter(Boolean).join(' '));
  const albums = list.map((x) => x.album).filter(Boolean) as Raw[];
  const m = best(albums, r, (x) => x.title, (x) => yearOf(x.releaseDate));
  if (!m) return undefined;
  const img = (m.images || []).find((i: Raw) => /cover/i.test(i.coverType)) || m.images?.[0];
  const url = sizedRemote(img?.remoteUrl || img?.url, 'poster');
  return url ? { image: url, source: 'lidarr', title: m.title, year: yearOf(m.releaseDate) } : undefined;
};

const tmdb: Source = async (r) => {
  const svc = services().tmdb;
  if (!svc || (r.category !== 'movies' && r.category !== 'tv')) return undefined;
  const list = r.category === 'movies' ? await svc.searchMovie(r.title, r.year) : await svc.searchTv(r.title, r.year);
  const m = best(list, r, (x) => x.title, (x) => x.year);
  return m?.poster ? { image: m.poster, source: 'tmdb', title: m.title, year: m.year, overview: m.overview } : undefined;
};

const ITUNES_MEDIA: Partial<Record<ContentType, { media: string; entity: string }>> = {
  movies: { media: 'movie', entity: 'movie' },
  tv: { media: 'tvShow', entity: 'tvSeason' },
  music: { media: 'music', entity: 'album' },
  audiobooks: { media: 'audiobook', entity: 'audiobook' },
  ebooks: { media: 'ebook', entity: 'ebook' },
  software: { media: 'software', entity: 'macSoftware' },
};

const itunes: Source = async (r) => {
  const m = ITUNES_MEDIA[r.category];
  if (!m) return undefined;
  const res = await get<Raw>('iTunes', 'https://itunes.apple.com', '/search', { term: [r.artist, r.title].filter(Boolean).join(' '), media: m.media, entity: m.entity, limit: 8 });
  const list = (res?.results || []) as Raw[];
  const name = (x: Raw) => (x.collectionName || x.trackName || '').replace(/\s*[-–]\s*Season \d+$/i, '').replace(/\s*\((Unabridged|Abridged)\)$/i, '');
  const hit = best(list, r, name, (x) => yearOf(x.releaseDate));
  if (!hit) return undefined;
  if (r.artist && hit.artistName && titleScore(r.artist, hit.artistName) < 0.3) return undefined;
  const art = String(hit.artworkUrl512 || hit.artworkUrl100 || hit.artworkUrl60 || '');
  if (!art) return undefined;
  return { image: art.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.$2'), imageAlt: art, source: 'itunes', title: name(hit), year: yearOf(hit.releaseDate) };
};

const openLibrary: Source = async (r) => {
  const res = await get<Raw>('Open Library', 'https://openlibrary.org', '/search.json', {
    title: r.title,
    author: r.artist,
    limit: 8,
    fields: 'key,title,author_name,cover_i,first_publish_year',
  });
  const docs = ((res?.docs || []) as Raw[]).filter((d) => d.cover_i);
  const hit = best(docs, r, (x) => x.title, (x) => x.first_publish_year, 0.55);
  if (!hit) return undefined;
  return {
    image: `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg`,
    imageAlt: `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg`,
    source: 'openlibrary',
    title: hit.title,
    year: hit.first_publish_year,
  };
};

const googleBooks: Source = async (r) => {
  const q = [`intitle:${r.title}`, r.artist ? `inauthor:${r.artist}` : ''].filter(Boolean).join(' ');
  const res = await get<Raw>('Google Books', 'https://www.googleapis.com', '/books/v1/volumes', { q, maxResults: 8, printType: 'books' });
  const items = ((res?.items || []) as Raw[]).map((i) => i.volumeInfo || {}).filter((v) => v.imageLinks?.thumbnail);
  const hit = best(items, r, (x) => [x.title, x.subtitle].filter(Boolean).join(' '), (x) => yearOf(x.publishedDate), 0.55);
  if (!hit) return undefined;
  const thumb = String(hit.imageLinks.thumbnail).replace(/^http:/, 'https:').replace('&edge=curl', '');
  return { image: thumb, source: 'googlebooks', title: hit.title, year: yearOf(hit.publishedDate), overview: hit.description };
};

const steam: Source = async (r) => {
  const res = await get<Raw>('Steam', 'https://store.steampowered.com', '/api/storesearch/', { term: r.title, l: 'english', cc: 'US' });
  const items = ((res?.items || []) as Raw[]).filter((i) => i.type === 'app' || !i.type);
  const hit = best(items, r, (x) => x.name, undefined, 0.55);
  if (!hit) return undefined;
  const tiny = String(hit.tiny_image || '');
  const base = /^(.*\/apps\/\d+\/)[^/]+$/.exec(tiny.split('?')[0])?.[1];
  return {
    image: base ? `${base}library_600x900.jpg` : tiny,
    imageAlt: base ? `${base}header.jpg` : undefined,
    source: 'steam',
    title: hit.name,
  };
};

const WIKI_HINT: Record<ContentType, string> = {
  movies: 'film',
  tv: 'TV series',
  music: 'album',
  audiobooks: 'novel',
  ebooks: 'book',
  comics: 'comic',
  games: 'video game',
  software: 'software',
  other: '',
};

const wikipedia: Source = async (r) => {
  const q = [r.title, r.category === 'music' ? r.artist : '', r.year && (r.category === 'movies' || r.category === 'tv') ? String(r.year) : '', WIKI_HINT[r.category]].filter(Boolean).join(' ');
  const res = await get<Raw>('Wikipedia', 'https://en.wikipedia.org', '/w/api.php', {
    action: 'query',
    format: 'json',
    formatversion: 2,
    generator: 'search',
    gsrsearch: q,
    gsrlimit: 5,
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: 500,
    redirects: 1,
  });
  const pages = ((res?.query?.pages || []) as Raw[]).filter((p) => p.thumbnail?.source).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const hit = best(pages, r, (p) => p.title, undefined, 0.6);
  return hit ? { image: hit.thumbnail.source, source: 'wikipedia', title: String(hit.title).replace(/\s*\([^)]*\)$/, '') } : undefined;
};

/** Which sources to try, in order. Local ones (your *arr apps) first. */
function sourcesFor(category: ContentType, online: boolean): Source[] {
  const local: Partial<Record<ContentType, Source[]>> = { movies: [radarr], tv: [sonarr], music: [lidarr] };
  const remote: Record<ContentType, Source[]> = {
    movies: [tmdb, itunes, wikipedia],
    tv: [tmdb, itunes, wikipedia],
    music: [itunes, wikipedia],
    audiobooks: [itunes, openLibrary, wikipedia],
    ebooks: [openLibrary, googleBooks, itunes, wikipedia],
    comics: [googleBooks, openLibrary, wikipedia],
    games: [steam, wikipedia],
    software: [itunes, wikipedia],
    other: [wikipedia],
  };
  const list = [...(local[category] || [])];
  if (online) list.push(...remote[category]);
  else if (category === 'movies' || category === 'tv') list.push(tmdb); // TMDB only when you added a key yourself
  return list;
}

async function lookup(r: ArtworkRequest): Promise<ArtworkMatch | null> {
  const online = getSettings().general.onlineArtwork !== false;
  for (const source of sourcesFor(r.category, online)) {
    try {
      const hit = await source(r);
      if (hit?.image) return hit;
    } catch (err) {
      log.debug(`artwork source failed for "${r.title}": ${(err as Error).message}`);
    }
  }
  return null;
}

/** Artwork for a batch of parsed titles (cached; a few lookups at a time). */
export async function findArtwork(requests: ArtworkRequest[]): Promise<Record<string, ArtworkMatch>> {
  const out: Record<string, ArtworkMatch> = {};
  const todo: ArtworkRequest[] = [];
  for (const r of requests) {
    const hit = cache.get(r.key);
    if (hit) out[r.key] = hit;
    else if (hit === undefined && r.title) todo.push(r);
  }
  const queue = [...new Map(todo.map((r) => [r.key, r])).values()];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const found = await lookup(r);
      cache.set(r.key, found);
      if (found) out[r.key] = found;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
