/*
 * API data shapes shared with the web UI (imported there as types only).
 * Keep this file free of runtime imports.
 */

export type MediaKind = 'movie' | 'series' | 'artist' | 'album' | 'book';
export type ArrService = 'radarr' | 'sonarr' | 'lidarr' | 'readarr';
export type Availability = 'available' | 'partial' | 'missing' | 'unreleased' | 'none';
export type Role = 'admin' | 'user';
/** Search categories, also used for "open with" assignments. */
export type ContentType = 'movies' | 'tv' | 'music' | 'audiobooks' | 'ebooks' | 'comics' | 'games' | 'software' | 'other';

/** One-click link into the app that opens something ("Watch in Plex", "Read in Komga"). */
export interface PlayLink {
  /** player id: jellyfin, plex, emby, navidrome, audiobookshelf, komga, kavita */
  app: string;
  /** display name of the app */
  name: string;
  url: string;
  verb: 'Watch' | 'Listen' | 'Read';
}

export interface MediaItem {
  /** Stable key, e.g. "movie:tmdb:27205" */
  key: string;
  kind: MediaKind;
  service: ArrService;
  /** Library id inside the *arr app (only when in library). */
  id?: number;
  inLibrary: boolean;
  title: string;
  sortTitle?: string;
  /** Secondary line: artist for albums, author for books, network/studio otherwise */
  subtitle?: string;
  year?: number;
  overview?: string;
  poster?: string;
  /** Fallback poster when the first one fails to load */
  posterAlt?: string;
  fanart?: string;
  genres?: string[];
  runtime?: number;
  rating?: number;
  certification?: string;
  status?: string;
  monitored?: boolean;
  availability: Availability;
  progress?: { have: number; total: number; percent: number };
  sizeOnDisk?: number;
  added?: string;
  releaseDate?: string;
  nextAiring?: string;
  seasonCount?: number;
  qualityProfileId?: number;
  path?: string;
  ids: { tmdb?: number; tvdb?: number; imdb?: string; mb?: string; foreign?: string };
  /** Where to watch / listen to it (the app assigned under Settings > Open with). */
  play?: PlayLink;
  /** Opaque lookup resource needed to add the item (search results only). */
  raw?: Record<string, unknown>;
  /** Why it is recommended ("Because you watched Dune"). */
  reason?: string;
}

export interface EpisodeView {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate?: string;
  overview?: string;
  hasFile: boolean;
  monitored: boolean;
  aired: boolean;
  quality?: string;
  size?: number;
  finaleType?: string;
}

export interface SeasonView {
  seasonNumber: number;
  monitored: boolean;
  episodeFileCount: number;
  episodeCount: number;
  totalEpisodeCount: number;
  sizeOnDisk: number;
  episodes: EpisodeView[];
}

export interface FileView {
  path: string;
  size: number;
  quality?: string;
  resolution?: string;
  videoCodec?: string;
  audio?: string;
  languages?: string[];
  subtitles?: string[];
  dateAdded?: string;
}

export interface MediaDetail {
  item: MediaItem;
  seasons?: SeasonView[];
  albums?: MediaItem[];
  files?: FileView[];
  /** Whatever useful links the UI can show */
  links: { label: string; url: string }[];
}

export interface ReleaseView {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  protocol: 'torrent' | 'usenet';
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  publishDate?: string;
  quality?: string;
  customFormatScore?: number;
  languages?: string[];
  rejected?: boolean;
  rejections?: string[];
  approved?: boolean;
  infoUrl?: string;
  categories?: { id: number; name: string }[];
  /** For indexer (Prowlarr) results: what AIO will do with it */
  kind?: GrabKind;
  grabs?: number;
  /** Indexer results: which search category it belongs to */
  category?: ContentType;
  /** Indexer results: the release name cleaned up (title, year, episode, platform ...) */
  parsed?: ParsedTitle;
  /** Cover art supplied by the indexer itself */
  poster?: string;
}

export interface ParsedTitle {
  /** Groups releases of the same thing ("movies:dune part two:2024") */
  key: string;
  title: string;
  year?: number;
  /** Artist / author */
  artist?: string;
  /** "S03E01", "Season 2", "#12", "v1.2.3", "PS5" ... */
  detail?: string;
  season?: number;
  episode?: number;
  ids?: { imdb?: string; tmdb?: number; tvdb?: number };
}

/** Artwork found for a parsed title. */
export interface ArtworkMatch {
  image?: string;
  imageAlt?: string;
  /** Where it came from: radarr, sonarr, lidarr, tmdb, itunes, openlibrary, steam, wikipedia, indexer */
  source?: string;
  /** The title the artwork belongs to (may differ in spelling) */
  title?: string;
  year?: number;
  overview?: string;
}

export interface CategoryInfo {
  id: ContentType;
  label: string;
  /** Has an *arr app that manages it (results show as posters you can add) */
  library?: ArrService;
  /** Can be searched on your indexers */
  indexer: boolean;
  /** What happens after downloading */
  kind: GrabKind;
}

export type GrabKind = 'music' | 'audiobook' | 'ebook' | 'comic' | 'files';
export type GrabStatus = 'queued' | 'downloading' | 'importing' | 'imported' | 'completed' | 'failed' | 'removed';

export interface GrabView {
  id: string;
  title: string;
  kind: GrabKind;
  client: string;
  clientName: string;
  downloadId?: string;
  protocol: 'torrent' | 'usenet';
  indexer?: string;
  size?: number;
  addedAt: string;
  updatedAt: string;
  status: GrabStatus;
  progress?: number;
  /** Local path of the downloaded content */
  contentPath?: string;
  /** Library folder the files were imported into */
  destination?: string;
  error?: string;
  /** Where to listen / read it (Navidrome, Audiobookshelf, Komga ...) */
  play?: PlayLink;
  /** Browser download link(s) for files */
  downloadUrl?: string;
  /** Search category it was grabbed from */
  category?: ContentType;
}

export type DownloadStateView =
  | 'downloading'
  | 'seeding'
  | 'completed'
  | 'paused'
  | 'queued'
  | 'stalled'
  | 'checking'
  | 'processing'
  | 'metadata'
  | 'failed'
  | 'error'
  | 'importing'
  | 'warning';

export interface DownloadView {
  key: string;
  /** client id (qbittorrent, sabnzbd...) or "arr" for items only known through an *arr queue */
  client: string;
  clientName: string;
  controllable: boolean;
  protocol: 'torrent' | 'usenet';
  id: string;
  altIds?: string[];
  name: string;
  category: string;
  state: DownloadStateView;
  rawState: string;
  progress: number;
  size: number;
  downloaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number | null;
  ratio?: number;
  seeds?: number;
  peers?: number;
  addedAt?: string;
  completedAt?: string;
  message?: string;
  done: boolean;
  paused: boolean;
  inHistory?: boolean;
  media?: { service: ArrService; kind: MediaKind; id?: number; title: string; subtitle?: string; poster?: string; posterAlt?: string; play?: PlayLink };
  /** The *arr app already imported this download into the library. */
  imported?: boolean;
  arr?: { service: ArrService; queueIds: number[]; status: string; trackedState?: string; trackedStatus?: string; messages: string[] };
  grab?: GrabView;
}

export interface ClientSummary {
  id: string;
  name: string;
  protocol: 'torrent' | 'usenet';
  online: boolean;
  error?: string;
  downloadSpeed: number;
  uploadSpeed: number;
  altSpeed?: boolean;
  supportsAltSpeed: boolean;
  paused?: boolean;
  publicUrl: string;
}

export interface DownloadsResponse {
  items: DownloadView[];
  clients: ClientSummary[];
  totals: { downloadSpeed: number; uploadSpeed: number; active: number };
  errors: string[];
}

export interface CalendarEvent {
  key: string;
  type: 'episode' | 'movie' | 'album' | 'book';
  service: ArrService;
  date: string;
  /** For movies: cinema / digital / physical */
  dateType?: string;
  title: string;
  subtitle?: string;
  hasFile: boolean;
  monitored: boolean;
  poster?: string;
  posterAlt?: string;
  mediaId?: number;
  allDay?: boolean;
}

export interface WantedItem {
  key: string;
  service: ArrService;
  kind: 'episode' | 'movie' | 'album' | 'book';
  id: number;
  mediaId?: number;
  title: string;
  subtitle?: string;
  date?: string;
  poster?: string;
  posterAlt?: string;
}

export interface HealthIssue {
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  wikiUrl?: string;
  source?: string;
}

export interface ServiceStatusView {
  id: string;
  name: string;
  group: 'media' | 'indexer' | 'download' | 'player' | 'subtitles' | 'discovery';
  enabled: boolean;
  online: boolean;
  version?: string;
  error?: string;
  publicUrl: string;
  health: HealthIssue[];
}

export interface DiskView {
  path: string;
  label?: string;
  free: number;
  total: number;
  services: string[];
}

export interface ActivityItem {
  key: string;
  service: ArrService;
  date: string;
  event: string;
  title: string;
  mediaTitle?: string;
  quality?: string;
  poster?: string;
  posterAlt?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export interface AppInfo {
  title: string;
  version: string;
  user: { username: string; role: Role; source: string };
  authMode: string;
  services: Record<string, { enabled: boolean; name: string; publicUrl: string }>;
  clients: { id: string; name: string; protocol: 'torrent' | 'usenet'; publicUrl: string }[];
  jellyfin?: { publicUrl: string; serverId?: string };
  /** The app that opens each kind of content (resolved from Settings > Open with) */
  players: Partial<Record<ContentType, { app: string; name: string; url: string }>>;
  /** The main app for watching movies & shows (sidebar shortcut) */
  watchApp?: { app: string; name: string; url: string };
  categories: CategoryInfo[];
  features: { music: boolean; books: boolean; indexerSearch: boolean; files: boolean; subtitles: boolean; recommendations: boolean; updates: boolean };
  /** Library folders AIO Arr imports direct downloads into (set under Settings > Open with) */
  libraries: Exclude<GrabKind, 'files'>[];
  /** Types set to "Download to this computer" under Settings > Open with */
  keepAsFiles: ContentType[];
}

/* ------------------------------ recommendations ------------------------------ */

export interface RecommendationSection {
  id: string;
  title: string;
  subtitle?: string;
  items: MediaItem[];
}

export interface RecommendationsResponse {
  sections: RecommendationSection[];
  /** Which source produced them (tmdb, jellyseerr, radarr) */
  sources: string[];
  /** Hints shown when something could make them better */
  hints: string[];
}

/* ------------------------------ updates ------------------------------ */

export type UpdateState = 'up-to-date' | 'available' | 'unknown' | 'local' | 'error';

export interface AppUpdateView {
  /** container id */
  id: string;
  name: string;
  /** Known app id (radarr, plex, aio-arr ...) */
  app?: string;
  appName: string;
  image: string;
  version?: string;
  /** Connected to AIO Arr (has a service config) */
  connected: boolean;
  running: boolean;
  state: UpdateState;
  message?: string;
  checkedAt?: string;
  /** Containers that share its network and are restarted with it (e.g. qBittorrent behind gluetun) */
  dependents?: string[];
  self?: boolean;
}

export interface UpdatesResponse {
  docker: { available: boolean; version?: string; error?: string };
  apps: AppUpdateView[];
  checkedAt?: string;
  /** Running update jobs */
  jobs: UpdateJobView[];
}

export interface UpdateJobView {
  id: string;
  container: string;
  name: string;
  status: 'queued' | 'pulling' | 'recreating' | 'waiting' | 'done' | 'failed' | 'up-to-date';
  message?: string;
  startedAt: string;
  finishedAt?: string;
}
