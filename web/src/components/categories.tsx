/* Search categories: the shared selection (header menu + search page chips). Nothing picked = everything. */
import clsx from 'clsx';
import { Check, LayoutGrid } from 'lucide-react';
import { useMemo } from 'react';
import { CONTENT_META, CONTENT_ORDER, useSearchCategories } from '../lib/content';
import { useApp } from '../lib/queries';
import { useRouter } from '../lib/router';
import type { CategoryInfo, ContentType } from '../lib/types';

export interface CategorySelection {
  /** categories you can search (an *arr app or the indexers handle them) */
  usable: CategoryInfo[];
  /** what gets searched */
  cats: ContentType[];
  /** everything is searched */
  allMode: boolean;
  toggle: (id: ContentType) => void;
  only: (id: ContentType) => void;
  all: () => void;
}

export function useCategorySelection(): CategorySelection {
  const { data: app } = useApp();
  const { path, search, navigate } = useRouter();
  const usable = useMemo(
    () => (app?.categories || []).filter((c) => c.library || c.indexer).sort((a, b) => CONTENT_ORDER.indexOf(a.id) - CONTENT_ORDER.indexOf(b.id)),
    [app],
  );
  const [cats, set] = useSearchCategories(app?.categories, search.get('cats'));
  const allMode = !usable.length || usable.every((c) => cats.includes(c.id));
  const save = (next: ContentType[]) => {
    set(next);
    // a ?cats= link was followed: from now on the remembered choice applies
    if (search.has('cats')) {
      const s = new URLSearchParams(search);
      s.delete('cats');
      const rest = s.toString();
      navigate(`${path}${rest ? `?${rest}` : ''}`, { replace: true });
    }
  };
  return {
    usable,
    cats,
    allMode,
    // from "everything", picking a category narrows to it; after that chips add and remove
    toggle: (id) => {
      if (allMode) return save([id]);
      const next = cats.includes(id) ? cats.filter((c) => c !== id) : [...cats, id];
      save(next.length && next.length < usable.length ? next : []);
    },
    only: (id) => save([id]),
    all: () => save([]),
  };
}

/** Chips under the search title. */
export function CategoryChips({ sel, counts, className }: { sel: CategorySelection; counts?: Partial<Record<ContentType, number>>; className?: string }) {
  if (sel.usable.length < 2) return null;
  const chip = (active: boolean) =>
    clsx(
      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
      active ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted hover:border-line-strong hover:text-fg',
    );
  return (
    <div className={clsx('no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5', className)} role="group" aria-label="Search in">
      <button type="button" className={chip(sel.allMode)} aria-pressed={sel.allMode} onClick={sel.all}>
        <LayoutGrid className="size-3.5" /> All
      </button>
      {sel.usable.map((c) => {
        const m = CONTENT_META[c.id];
        const active = !sel.allMode && sel.cats.includes(c.id);
        const n = counts?.[c.id];
        return (
          <button
            key={c.id}
            type="button"
            className={chip(active)}
            aria-pressed={active}
            onClick={() => sel.toggle(c.id)}
            title={sel.allMode ? `Search only ${m.label.toLowerCase()}` : active ? `Stop searching ${m.label.toLowerCase()}` : `Also search ${m.label.toLowerCase()}`}
          >
            {active ? <Check className="size-3.5" /> : <m.icon className="size-3.5" />}
            {m.label}
            {n !== undefined && (sel.allMode || active) && <span className="tabular-nums opacity-70">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Rows for the header's "Search in" menu. */
export function CategoryMenu({ sel, onDone }: { sel: CategorySelection; onDone?: () => void }) {
  const row = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-card-hover';
  return (
    <div>
      <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Search in</div>
      <button
        type="button"
        className={row}
        onClick={() => {
          sel.all();
          onDone?.();
        }}
      >
        <LayoutGrid className="size-4 text-muted" />
        <span className="flex-1 font-medium">Everything</span>
        {sel.allMode && <Check className="size-4 text-accent" />}
      </button>
      <div className="my-1 border-t border-line" />
      {sel.usable.map((c) => {
        const m = CONTENT_META[c.id];
        const active = !sel.allMode && sel.cats.includes(c.id);
        return (
          <div key={c.id} className="group/row flex items-center">
            <button type="button" className={row} onClick={() => sel.toggle(c.id)} aria-pressed={active}>
              <m.icon className="size-4 text-muted" />
              <span className="flex-1">{m.label}</span>
              {active && <Check className="size-4 text-accent" />}
            </button>
            <button
              type="button"
              onClick={() => {
                sel.only(c.id);
                onDone?.();
              }}
              className="ml-1 rounded-md px-2 py-1 text-[11px] font-semibold text-subtle opacity-0 group-hover/row:opacity-100 hover:bg-card-hover hover:text-accent focus-visible:opacity-100 max-md:opacity-100"
            >
              Only
            </button>
          </div>
        );
      })}
    </div>
  );
}
