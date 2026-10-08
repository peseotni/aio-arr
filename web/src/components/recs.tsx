/* Recommendation rows (home page and "For you"). */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, errorMessage } from '../lib/api';
import type { MediaItem, RecommendationSection, RecommendationsResponse } from '../lib/types';
import { MediaCard, Row, useDownloadIndex } from './media';
import { useToast } from './overlay';

/** "Not interested": hide it right away and remember it on the server. */
export function useDismiss(): (item: MediaItem) => void {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    (item: MediaItem) => {
      const prev = qc.getQueryData<RecommendationsResponse>(['recs']);
      if (prev) {
        qc.setQueryData<RecommendationsResponse>(['recs'], {
          ...prev,
          sections: prev.sections.map((s) => ({ ...s, items: s.items.filter((i) => i.key !== item.key) })).filter((s) => s.items.length),
        });
      }
      api.post('/api/recommendations/dismiss', { key: item.key }).then(
        () => toast.info(`You won't see ${item.title} again`),
        (err) => {
          if (prev) qc.setQueryData(['recs'], prev);
          toast.error('Could not hide it', errorMessage(err));
        },
      );
    },
    [qc, toast],
  );
}

export function RecommendationRow({ section, showKind }: { section: RecommendationSection; showKind?: boolean }) {
  const dismiss = useDismiss();
  const dlIndex = useDownloadIndex();
  return (
    <Row>
      {section.items.map((m) => (
        <div key={m.key} className="w-32 shrink-0 sm:w-36">
          <MediaCard item={m} dl={m.id ? dlIndex.get(`${m.service}:${m.id}`) : undefined} showKind={showKind} showReason onDismiss={() => dismiss(m)} />
        </div>
      ))}
    </Row>
  );
}

/** Does a section mix movies and shows (then cards say which is which)? */
export const mixedKinds = (s: RecommendationSection) => new Set(s.items.map((i) => i.kind)).size > 1;

export const SOURCE_NAME: Record<string, string> = { tmdb: 'TMDB', jellyseerr: 'Jellyseerr', radarr: 'Radarr' };
