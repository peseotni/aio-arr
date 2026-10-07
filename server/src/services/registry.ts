/* Builds service clients from the current settings; rebuilt whenever settings change. */
import {
  CLIENT_IDS,
  SERVICE_NAMES,
  TORRENT_CLIENTS,
  USENET_CLIENTS,
  getSettings,
  onSettingsChange,
  type ClientId,
  type ServiceConfig,
  type ServiceId,
  type Settings,
} from '../config.js';
import { HttpError } from '../util/http.js';
import { clearCache } from '../util/cache.js';
import { LidarrService, ProwlarrService, RadarrService, ReadarrService, SonarrService } from './arr.js';
import { AudiobookshelfService, BazarrService, NavidromeService } from './audio.js';
import { JellyfinService } from './jellyfin.js';
import type { BaseService } from './base.js';
import { QBittorrentClient } from './clients/qbittorrent.js';
import { TransmissionClient } from './clients/transmission.js';
import { DelugeClient } from './clients/deluge.js';
import { SabnzbdClient } from './clients/sabnzbd.js';
import { NzbgetClient } from './clients/nzbget.js';
import type { DownloadClient } from './clients/types.js';

export interface Registry {
  radarr?: RadarrService;
  sonarr?: SonarrService;
  lidarr?: LidarrService;
  readarr?: ReadarrService;
  prowlarr?: ProwlarrService;
  bazarr?: BazarrService;
  jellyfin?: JellyfinService;
  navidrome?: NavidromeService;
  audiobookshelf?: AudiobookshelfService;
  clients: DownloadClient[];
}

const usable = (c: ServiceConfig | undefined): c is ServiceConfig => !!c && c.enabled && !!c.url;

export function createService(id: ServiceId, cfg: ServiceConfig): BaseService {
  const name = SERVICE_NAMES[id];
  switch (id) {
    case 'radarr':
      return new RadarrService(id, name, cfg);
    case 'sonarr':
      return new SonarrService(id, name, cfg);
    case 'lidarr':
      return new LidarrService(id, name, cfg);
    case 'readarr':
      return new ReadarrService(id, name, cfg);
    case 'prowlarr':
      return new ProwlarrService(id, name, cfg);
    case 'bazarr':
      return new BazarrService(id, name, cfg);
    case 'jellyfin':
      return new JellyfinService(id, name, cfg);
    case 'navidrome':
      return new NavidromeService(id, name, cfg);
    case 'audiobookshelf':
      return new AudiobookshelfService(id, name, cfg);
  }
}

export function createClient(id: ClientId, cfg: ServiceConfig): DownloadClient {
  switch (id) {
    case 'qbittorrent':
      return new QBittorrentClient(cfg);
    case 'transmission':
      return new TransmissionClient(cfg);
    case 'deluge':
      return new DelugeClient(cfg);
    case 'sabnzbd':
      return new SabnzbdClient(cfg);
    case 'nzbget':
      return new NzbgetClient(cfg);
  }
}

function build(s: Settings): Registry {
  const r: Registry = { clients: [] };
  const svc = s.services;
  if (usable(svc.radarr)) r.radarr = createService('radarr', svc.radarr) as RadarrService;
  if (usable(svc.sonarr)) r.sonarr = createService('sonarr', svc.sonarr) as SonarrService;
  if (usable(svc.lidarr)) r.lidarr = createService('lidarr', svc.lidarr) as LidarrService;
  if (usable(svc.readarr)) r.readarr = createService('readarr', svc.readarr) as ReadarrService;
  if (usable(svc.prowlarr)) r.prowlarr = createService('prowlarr', svc.prowlarr) as ProwlarrService;
  if (usable(svc.bazarr)) r.bazarr = createService('bazarr', svc.bazarr) as BazarrService;
  if (usable(svc.jellyfin)) r.jellyfin = createService('jellyfin', svc.jellyfin) as JellyfinService;
  if (usable(svc.navidrome)) r.navidrome = createService('navidrome', svc.navidrome) as NavidromeService;
  if (usable(svc.audiobookshelf)) r.audiobookshelf = createService('audiobookshelf', svc.audiobookshelf) as AudiobookshelfService;
  for (const id of CLIENT_IDS) {
    if (usable(s.clients[id])) r.clients.push(createClient(id, s.clients[id]));
  }
  return r;
}

let current: Registry | undefined;

export function services(): Registry {
  if (!current) current = build(getSettings());
  return current;
}

onSettingsChange(() => {
  current = undefined;
  clearCache();
});

export function need<T>(svc: T | undefined, name: string): T {
  if (!svc) throw new HttpError(`${name} is not configured. Add it under Settings.`, 409);
  return svc;
}

export function getClient(id: string): DownloadClient {
  const c = services().clients.find((x) => x.id === id);
  if (!c) throw new HttpError(`Download client "${id}" is not configured`, 404);
  return c;
}

/** Preferred client for a protocol (settings choice, else first enabled one). */
export function clientFor(protocol: 'torrent' | 'usenet'): DownloadClient | undefined {
  const s = getSettings();
  const pref = protocol === 'torrent' ? s.general.torrentClient : s.general.usenetClient;
  const list = services().clients;
  const allowed = protocol === 'torrent' ? TORRENT_CLIENTS : USENET_CLIENTS;
  return (pref && list.find((c) => c.id === pref)) || list.find((c) => allowed.includes(c.id));
}
