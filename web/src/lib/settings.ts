/* Settings as the admin API returns them (secrets are masked). */
import type { ContentType } from './types';

export interface ServiceConfig {
  enabled: boolean;
  url: string;
  publicUrl: string;
  apiKey: string;
  username: string;
  password: string;
  userId: string;
  defaults: {
    qualityProfileId?: number;
    metadataProfileId?: number;
    rootFolderPath?: string;
    monitor?: string;
    minimumAvailability?: string;
    seriesType?: string;
    searchOnAdd?: boolean;
  };
}

export type LibraryPath = 'music' | 'audiobooks' | 'ebooks' | 'comics';

export interface Settings {
  general: { title: string; jellyfinLogin: 'off' | 'admins' | 'all'; torrentClient: string; usenetClient: string; categoryPrefix: string; onlineArtwork: boolean };
  services: Record<string, ServiceConfig>;
  clients: Record<string, ServiceConfig>;
  /** auto, download, or a player id */
  players: Record<ContentType, string>;
  paths: { downloads: string[]; mappings: { from: string; to: string }[]; importMode: string } & Record<LibraryPath, string>;
}

export interface OpenWithInfo {
  options: { id: string; name: string; connected: boolean }[];
  /** what "Automatic" picks right now */
  auto?: { id: string; name: string };
  current?: string;
}

export interface SettingsResponse {
  settings: Settings;
  locked: string[];
  openWith: Record<ContentType, OpenWithInfo>;
  /** AIO Arr can reach Docker (one-click updates) */
  docker: boolean;
}

export interface PathCheck {
  path: string;
  exists: boolean;
  writable: boolean;
}
