import { BookOpen, ChevronLeft, ChevronRight, Disc3, Film, Inbox, Search, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { shortDate } from '../lib/format';
import { useApp, useWanted } from '../lib/queries';
import type { MediaItem, WantedItem } from '../lib/types';
import { Poster, useMedia } from '../components/media';
import { useToast } from '../components/overlay';
import { Button, EmptyState, ErrorNote, IconButton, PageHeader, Skeleton, Tabs } from '../components/ui';

type Svc = 'sonarr' | 'radarr' | 'lidarr' | 'readarr';

function Row({ w, service }: { w: WantedItem; service: Svc }) {
  const toast = useToast();
  const { open } = useMedia();
  const [busy, setBusy] = useState(false);
  const kind = w.kind === 'episode' ? 'series' : w.kind === 'album' ? 'artist' : w.kind;
  const stub: MediaItem | null = w.mediaId
    ? { key: `${kind}:${w.mediaId}`, kind, service, id: w.mediaId, inLibrary: true, title: w.kind === 'album' ? w.subtitle || w.title : w.title, poster: w.poster, posterAlt: w.posterAlt, availability: 'missing', ids: {} }
    : null;
  return (
    <div className="flex items-center gap-3 p-3">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => stub && open(stub)}>
        <div className="w-10 shrink-0">
          <Poster src={w.poster} fallback={w.posterAlt} kind={w.kind === 'episode' ? 'series' : w.kind} title={w.title} rounded="rounded-md" compact />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{w.title}</div>
          <div className="truncate text-xs text-muted">{w.subtitle}</div>
        </div>
      </button>
      <div className="hidden w-28 text-right text-xs text-subtle sm:block">{w.date ? shortDate(w.date) : ''}</div>
      <IconButton
        icon={Search}
        label="Search now"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/api/wanted/${service}/search`, { ids: [w.id] });
            toast.success(`Searching for ${w.title}`, w.subtitle);
          } catch (err) {
            toast.error('Search failed', errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

export function WantedPage() {
  const { data: app } = useApp();
  const svc = app?.services || {};
  const tabs = (
    [
      { value: 'sonarr', label: 'Episodes', icon: Tv },
      { value: 'radarr', label: 'Movies', icon: Film },
      { value: 'lidarr', label: 'Albums', icon: Disc3 },
      { value: 'readarr', label: 'Books', icon: BookOpen },
    ] as const
  ).filter((t) => svc[t.value]?.enabled);
  const [tab, setTab] = useState<Svc>('sonarr');
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (tabs.length && !tabs.some((t) => t.value === tab)) setTab(tabs[0].value);
  }, [tabs, tab]);
  useEffect(() => setPage(1), [tab]);
  const { data, isLoading, error } = useWanted(tab, page, !!svc[tab]?.enabled);
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <div>
      <PageHeader
        icon={Inbox}
        title="Wanted"
        subtitle="Monitored items that are released but not downloaded yet"
        actions={
          <Button
            variant="primary"
            icon={Search}
            loading={busy}
            disabled={!data?.total}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/wanted/${tab}/search`, {});
                toast.success('Searching for everything that is missing', 'This runs in the background and can take a while.');
                void qc.invalidateQueries({ queryKey: ['downloads'] });
              } catch (err) {
                toast.error('Search failed', errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Search all missing
          </Button>
        }
      />
      {tabs.length > 1 && <Tabs className="mb-4" value={tab} onChange={setTab} items={tabs.map((t) => ({ ...t, count: t.value === tab ? data?.total : undefined }))} />}
      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
      {isLoading ? (
        <Skeleton className="h-80" />
      ) : !data?.items.length ? (
        <EmptyState icon={Inbox} title="Nothing missing">
          Everything that is monitored and released has been downloaded.
        </EmptyState>
      ) : (
        <>
          <div className="card divide-y divide-line">
            {data.items.map((w) => (
              <Row key={w.key} w={w} service={tab} />
            ))}
          </div>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm text-muted">
              <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button size="sm" variant="ghost" iconRight={ChevronRight} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
