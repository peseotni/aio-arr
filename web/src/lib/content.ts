/* Content types (search categories / "open with"), their icons and the remembered search selection. */
import { AppWindow, BookHeadphones, BookOpen, Film, Gamepad2, Music, PanelsTopLeft, Shapes, Tv } from 'lucide-react';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import type { CategoryInfo, ContentType, GrabKind } from './types';

export const CONTENT_ORDER: ContentType[] = ['movies', 'tv', 'music', 'audiobooks', 'ebooks', 'comics', 'games', 'software', 'other'];

export const CONTENT_META: Record<ContentType, { label: string; short: string; icon: ComponentType<{ className?: string }>; shape: 'poster' | 'square' }> = {
  movies: { label: 'Movies', short: 'Movies', icon: Film, shape: 'poster' },
  tv: { label: 'TV shows', short: 'TV', icon: Tv, shape: 'poster' },
  music: { label: 'Music', short: 'Music', icon: Music, shape: 'square' },
  audiobooks: { label: 'Audiobooks', short: 'Audiobooks', icon: BookHeadphones, shape: 'square' },
  ebooks: { label: 'Books', short: 'Books', icon: BookOpen, shape: 'poster' },
  comics: { label: 'Comics', short: 'Comics', icon: PanelsTopLeft, shape: 'poster' },
  games: { label: 'Games', short: 'Games', icon: Gamepad2, shape: 'poster' },
  software: { label: 'Software', short: 'Apps', icon: AppWindow, shape: 'square' },
  other: { label: 'Other', short: 'Other', icon: Shapes, shape: 'poster' },
};

export const GRAB_KIND_META: Record<GrabKind, { label: string; icon: ComponentType<{ className?: string }>; hint: string; content: ContentType }> = {
  music: { label: 'Music', icon: Music, hint: 'Added to your music library', content: 'music' },
  audiobook: { label: 'Audiobook', icon: BookHeadphones, hint: 'Added to your audiobook library', content: 'audiobooks' },
  ebook: { label: 'Book', icon: BookOpen, hint: 'Added to your book library', content: 'ebooks' },
  comic: { label: 'Comic', icon: PanelsTopLeft, hint: 'Added to your comics library', content: 'comics' },
  files: { label: 'File', icon: AppWindow, hint: 'Download it to this computer from Downloads', content: 'other' },
};

const STORAGE_KEY = 'aio.search.categories';

function readStored(): ContentType[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as unknown;
    if (Array.isArray(v)) return v.filter((x): x is ContentType => CONTENT_ORDER.includes(x as ContentType));
  } catch {
    /* private mode */
  }
  return undefined;
}

/** Selected search categories: from the URL (?cats=movies,tv), else what you picked last time, else everything. */
export function useSearchCategories(available: CategoryInfo[] | undefined, fromUrl?: string | null): [ContentType[], (next: ContentType[]) => void] {
  const usable = (available || []).filter((c) => c.library || c.indexer).map((c) => c.id);
  const pick = useCallback(
    (list: ContentType[] | undefined) => {
      const ok = (list || []).filter((c) => !available || usable.includes(c));
      return ok.length ? ok : usable.length ? usable : CONTENT_ORDER;
    },
    [usable.join(',')],
  );
  const urlList = fromUrl ? (fromUrl.split(',').filter((x) => CONTENT_ORDER.includes(x as ContentType)) as ContentType[]) : undefined;
  const [stored, setStored] = useState<ContentType[] | undefined>(readStored);
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === STORAGE_KEY && setStored(readStored());
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const current = pick(urlList?.length ? urlList : stored);
  const set = useCallback((next: ContentType[]) => {
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);
  return [current, set];
}

/** "All" when everything usable is selected. */
export function categorySummary(selected: ContentType[], available: CategoryInfo[] | undefined): string {
  const usable = (available || []).filter((c) => c.library || c.indexer).map((c) => c.id);
  if (!usable.length || usable.every((c) => selected.includes(c))) return 'All';
  if (selected.length === 1) return CONTENT_META[selected[0]].short;
  return `${selected.length} types`;
}
