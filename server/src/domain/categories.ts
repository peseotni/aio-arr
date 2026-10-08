/* Search categories: what you can search for, where it is searched and what happens after downloading. */
import { CONTENT_TYPES, type ContentType } from '../config.js';
import type { Registry } from '../services/registry.js';
import type { ArrService, CategoryInfo, GrabKind } from '../types.js';

export interface CategoryDef {
  label: string;
  /** Newznab / Torznab categories searched on the indexers */
  torznab: number[];
  /** What happens after downloading */
  kind: GrabKind;
  /** *arr app that manages this type (its results show as posters you can add) */
  library?: ArrService;
}

export const CATEGORIES: Record<ContentType, CategoryDef> = {
  movies: { label: 'Movies', torznab: [2000], kind: 'files', library: 'radarr' },
  tv: { label: 'TV shows', torznab: [5000], kind: 'files', library: 'sonarr' },
  music: { label: 'Music', torznab: [3000], kind: 'music', library: 'lidarr' },
  audiobooks: { label: 'Audiobooks', torznab: [3030], kind: 'audiobook' },
  ebooks: { label: 'Books', torznab: [7000], kind: 'ebook', library: 'readarr' },
  comics: { label: 'Comics', torznab: [7030], kind: 'comic' },
  games: { label: 'Games', torznab: [1000, 4050], kind: 'files' },
  software: { label: 'Software', torznab: [4000], kind: 'files' },
  other: { label: 'Other', torznab: [8000], kind: 'files' },
};

export const isCategory = (v: unknown): v is ContentType => typeof v === 'string' && (CONTENT_TYPES as readonly string[]).includes(v);

/** "movies,tv" -> ['movies', 'tv'] (unknown ids dropped; empty = everything). */
export function parseCategories(v: string | undefined): ContentType[] {
  const list = (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(isCategory);
  return list.length ? [...new Set(list)] : [...CONTENT_TYPES];
}

/** Which of our categories an indexer result belongs to (by its Newznab ids, then its category names). */
export function classify(categories: { id: number; name?: string }[] = []): ContentType {
  const ids = categories.map((c) => c.id).filter((id) => id < 100000);
  const has = (from: number, to = from) => ids.some((id) => id >= from && id <= to);
  if (has(3030)) return 'audiobooks';
  if (has(7030)) return 'comics';
  if (has(7000, 7999)) return 'ebooks';
  if (has(3000, 3999)) return 'music';
  if (has(4050) || has(1000, 1999)) return 'games';
  if (has(4000, 4999)) return 'software';
  if (has(2000, 2999)) return 'movies';
  if (has(5000, 5999)) return 'tv';
  // indexer-specific categories only: go by their names
  const names = categories.map((c) => (c.name || '').toLowerCase()).join(' | ');
  if (/audio\s?books?/.test(names)) return 'audiobooks';
  if (/comic|manga/.test(names)) return 'comics';
  if (/e-?books?|books?\b/.test(names)) return 'ebooks';
  if (/\b(music|audio|flac|mp3|lossless)\b/.test(names)) return 'music';
  if (/\bgames?\b|console/.test(names)) return 'games';
  if (/software|apps?\b|applications?|\bpc\b/.test(names)) return 'software';
  if (/movies?|films?/.test(names)) return 'movies';
  if (/\btv\b|series|episodes?/.test(names)) return 'tv';
  return 'other';
}

/** Torznab ids to send for a set of categories. */
export function torznabFor(cats: ContentType[]): number[] {
  return [...new Set(cats.flatMap((c) => CATEGORIES[c].torznab))];
}

/** Category list for the UI, with what is actually possible on this setup. */
export function categoryInfo(reg: Registry): CategoryInfo[] {
  return CONTENT_TYPES.map((id) => {
    const d = CATEGORIES[id];
    return { id, label: d.label, library: d.library && reg[d.library] ? d.library : undefined, indexer: !!reg.prowlarr, kind: d.kind };
  });
}
