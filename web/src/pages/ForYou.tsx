import { RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useApp, useRecommendations } from '../lib/queries';
import { Link } from '../lib/router';
import type { RecommendationsResponse } from '../lib/types';
import { RecommendationRow, SOURCE_NAME, mixedKinds } from '../components/recs';
import { useToast } from '../components/overlay';
import { Button, EmptyState, ErrorNote, InfoNote, PageHeader, SectionHeader, Skeleton } from '../components/ui';

export function ForYouPage() {
  const { data: app } = useApp();
  const enabled = !!app?.features.recommendations;
  const { data, isLoading, error } = useRecommendations(enabled);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = app?.user.role === 'admin';

  const refresh = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['recs'], await api.post<RecommendationsResponse>('/api/recommendations/refresh'));
    } catch (err) {
      toast.error('Could not refresh', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (app && !enabled) {
    return (
      <EmptyState icon={Sparkles} title="Recommendations need Radarr or Sonarr">
        Connect Radarr or Sonarr{isAdmin ? ' in Settings' : ''} - suggestions are added there with one click.
      </EmptyState>
    );
  }

  const sources = (data?.sources || []).map((s) => SOURCE_NAME[s] || s).join(', ');
  return (
    <div className="space-y-8">
      <PageHeader
        icon={Sparkles}
        title="For you"
        subtitle="Movies and shows picked from what you watch and download - one click to get them"
        actions={
          <Button variant="secondary" icon={RefreshCw} loading={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      {error && <ErrorNote>{errorMessage(error)}</ErrorNote>}
      {data?.hints.map((h) => (
        <InfoNote key={h}>
          {h}
          {isAdmin && /Settings/.test(h) && (
            <>
              {' '}
              <Link to="/settings?tab=apps" className="font-semibold text-accent hover:underline">
                Open settings
              </Link>
            </>
          )}
        </InfoNote>
      ))}
      {isLoading ? (
        <div className="space-y-8">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="mb-3 h-5 w-48" />
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 7 }).map((_, j) => (
                  <Skeleton key={j} className="aspect-[2/3] w-32 shrink-0 sm:w-36" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : data && !data.sections.length ? (
        <EmptyState icon={Sparkles} title="Nothing to suggest yet">
          Watch or download a few movies and shows and suggestions based on them will appear here.
        </EmptyState>
      ) : (
        data?.sections.map((s) => (
          <section key={s.id}>
            <SectionHeader title={s.title} subtitle={s.subtitle} />
            <RecommendationRow section={s} showKind={mixedKinds(s)} />
          </section>
        ))
      )}
      {sources && <p className="text-xs text-subtle">Suggestions from {sources}. Hover a title and press × if it's not for you.</p>}
    </div>
  );
}
