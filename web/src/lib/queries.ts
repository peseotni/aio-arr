/* All server data hooks in one place. */
import { useQuery } from '@tanstack/react-query';
import { api, qs } from './api';
import type {
  ActivityItem,
  AppInfo,
  CalendarEvent,
  DiskView,
  DownloadsResponse,
  FileEntry,
  GrabKind,
  GrabView,
  MediaDetail,
  MediaItem,
  MediaKind,
  ReleaseView,
  ServiceStatusView,
  WantedItem,
} from './types';

export interface AuthState {
  authenticated: boolean;
  user?: { username: string; role: 'admin' | 'user'; source: string };
  authMode: 'local' | 'none' | 'proxy';
  setupRequired: boolean;
  jellyfinLogin: boolean;
  title: string;
}

export const useAuthState = () => useQuery({ queryKey: ['auth'], queryFn: () => api.get<AuthState>('/api/auth/state'), staleTime: 60_000 });

export const useApp = () => useQuery({ queryKey: ['app'], queryFn: () => api.get<AppInfo>('/api/app'), staleTime: 60_000 });

export const useStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<{ services: ServiceStatusView[]; disks: DiskView[] }>('/api/status'),
    refetchInterval: 60_000,
  });

export const useDownloads = (fast = false) =>
  useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.get<DownloadsResponse>('/api/downloads'),
    refetchInterval: fast ? 2000 : 6000,
    refetchIntervalInBackground: false,
  });

export const useGrabs = () => useQuery({ queryKey: ['grabs'], queryFn: () => api.get<GrabView[]>('/api/grabs'), refetchInterval: 5000 });

export const useLibrary = (kind: MediaKind, enabled = true) =>
  useQuery({ queryKey: ['library', kind], queryFn: () => api.get<MediaItem[]>(`/api/library/${kind}`), enabled, staleTime: 20_000 });

export const useDetail = (kind: MediaKind | undefined, id: number | undefined) =>
  useQuery({
    queryKey: ['detail', kind, id],
    queryFn: () => api.get<MediaDetail>(`/api/library/${kind}/${id}`),
    enabled: !!kind && !!id && kind !== 'album',
  });

export interface SearchSection {
  items: MediaItem[];
  error?: string;
}
export interface SearchResponse {
  movies?: SearchSection;
  series?: SearchSection;
  artists?: SearchSection;
  albums?: SearchSection;
  books?: SearchSection;
}

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/api/search${qs({ q })}`, signal),
    enabled: q.trim().length > 0,
    staleTime: 5 * 60_000,
  });

export const useIndexerSearch = (q: string, cat: string, enabled: boolean) =>
  useQuery({
    queryKey: ['indexer-search', q, cat],
    queryFn: ({ signal }) => api.get<ReleaseView[]>(`/api/indexers/search${qs({ q, cat })}`, signal),
    enabled: enabled && q.trim().length > 0,
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useIndexerCategories = () =>
  useQuery({ queryKey: ['indexer-cats'], queryFn: () => api.get<{ id: string; label: string }[]>('/api/indexers/categories'), staleTime: Infinity });

export const useCalendar = (start: string, end: string) =>
  useQuery({
    queryKey: ['calendar', start, end],
    queryFn: () => api.get<{ events: CalendarEvent[]; errors: string[] }>(`/api/calendar${qs({ start, end })}`),
    staleTime: 60_000,
  });

export const useWanted = (service: string, page: number, enabled = true) =>
  useQuery({
    queryKey: ['wanted', service, page],
    queryFn: () => api.get<{ items: WantedItem[]; total: number }>(`/api/wanted/${service}${qs({ page })}`),
    enabled,
  });

export const useActivity = (limit = 30) =>
  useQuery({ queryKey: ['activity', limit], queryFn: () => api.get<ActivityItem[]>(`/api/activity${qs({ limit })}`), refetchInterval: 60_000 });

export interface JellyfinCard {
  id: string;
  name: string;
  type: string;
  subtitle?: string;
  image?: string;
  backdrop?: string;
  progress?: number;
  url: string;
  year?: number;
  runtime?: number;
}

export const useJellyfinHome = (enabled: boolean) =>
  useQuery({
    queryKey: ['jf-home'],
    queryFn: () => api.get<{ resume: JellyfinCard[]; nextUp: JellyfinCard[]; latest: JellyfinCard[] }>('/api/jellyfin/home'),
    enabled,
    refetchInterval: 60_000,
  });

export interface NowPlaying {
  id: string;
  user: string;
  client: string;
  device: string;
  title: string;
  subtitle?: string;
  image?: string;
  progress?: number;
  paused: boolean;
  transcoding: boolean;
}

export const useSessions = (enabled: boolean) =>
  useQuery({ queryKey: ['jf-sessions'], queryFn: () => api.get<NowPlaying[]>('/api/jellyfin/sessions'), enabled, refetchInterval: 15_000 });

export const useDiscover = (enabled: boolean) =>
  useQuery({ queryKey: ['discover'], queryFn: () => api.get<MediaItem[]>('/api/discover'), enabled, staleTime: 30 * 60_000, retry: false });

export interface AddOptions {
  qualityProfiles: { id: number; name: string }[];
  metadataProfiles?: { id: number; name: string }[];
  rootFolders: { path: string; freeSpace?: number }[];
  defaults: {
    qualityProfileId?: number;
    metadataProfileId?: number;
    rootFolderPath?: string;
    monitor?: string;
    minimumAvailability?: string;
    seriesType?: string;
    searchOnAdd: boolean;
  };
}

export const useAddOptions = (service: string | undefined) =>
  useQuery({ queryKey: ['options', service], queryFn: () => api.get<AddOptions>(`/api/options/${service}`), enabled: !!service, staleTime: 60_000 });

export interface RootView {
  path: string;
  label: string;
  kind: string;
  free?: number;
  total?: number;
}

export const useFileRoots = () => useQuery({ queryKey: ['file-roots'], queryFn: () => api.get<RootView[]>('/api/files/roots') });

export const useFileList = (path: string | undefined) =>
  useQuery({
    queryKey: ['files', path],
    queryFn: () => api.get<{ path: string; parent?: string; root: RootView; entries: FileEntry[] }>(`/api/files/list${qs({ path })}`),
    enabled: !!path,
  });

export interface IndexerStatus {
  id: number;
  name: string;
  enabled: boolean;
  protocol: string;
  privacy: string;
  failing: boolean;
  disabledTill?: string;
}

export const useIndexers = (enabled: boolean) =>
  useQuery({ queryKey: ['indexers'], queryFn: () => api.get<IndexerStatus[]>('/api/indexers/status'), enabled, staleTime: 60_000 });

/* ---------------- mutations ---------------- */

export function addMedia(kind: MediaKind, body: Record<string, unknown>) {
  return api.post<MediaItem>(`/api/library/${kind}`, body);
}

export function grabIndexerRelease(guid: string, indexerId: number, kind?: GrabKind) {
  return api.post<GrabView>('/api/indexers/grab', { guid, indexerId, kind });
}
