/*
 * Settings: defaults <- /config/settings.json <- environment variables.
 * Values that come from the environment are "locked" and shown read-only in the UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { moduleLogger } from './log.js';

const log = moduleLogger('config');

export const ARR_IDS = ['radarr', 'sonarr', 'lidarr', 'readarr'] as const;
export const SERVICE_IDS = [...ARR_IDS, 'prowlarr', 'bazarr', 'jellyfin', 'navidrome', 'audiobookshelf'] as const;
export const CLIENT_IDS = ['qbittorrent', 'transmission', 'deluge', 'sabnzbd', 'nzbget'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];
export type ClientId = (typeof CLIENT_IDS)[number];
export const TORRENT_CLIENTS: ClientId[] = ['qbittorrent', 'transmission', 'deluge'];
export const USENET_CLIENTS: ClientId[] = ['sabnzbd', 'nzbget'];

export const SERVICE_NAMES: Record<ServiceId | ClientId, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
  readarr: 'Readarr',
  prowlarr: 'Prowlarr',
  bazarr: 'Bazarr',
  jellyfin: 'Jellyfin',
  navidrome: 'Navidrome',
  audiobookshelf: 'Audiobookshelf',
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
};

export const DEFAULT_URLS: Record<ServiceId | ClientId, string> = {
  radarr: 'http://radarr:7878',
  sonarr: 'http://sonarr:8989',
  lidarr: 'http://lidarr:8686',
  readarr: 'http://readarr:8787',
  prowlarr: 'http://prowlarr:9696',
  bazarr: 'http://bazarr:6767',
  jellyfin: 'http://jellyfin:8096',
  navidrome: 'http://navidrome:4533',
  audiobookshelf: 'http://audiobookshelf:80',
  qbittorrent: 'http://qbittorrent:8080',
  transmission: 'http://transmission:9091',
  deluge: 'http://deluge:8112',
  sabnzbd: 'http://sabnzbd:8080',
  nzbget: 'http://nzbget:6789',
};

export interface ServiceDefaults {
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  /** Sonarr/Lidarr add "monitor" option (all, future, missing, ...) */
  monitor?: string;
  /** Radarr minimum availability (announced, inCinemas, released) */
  minimumAvailability?: string;
  /** Sonarr series type (standard, daily, anime) */
  seriesType?: string;
  /** Start searching right after adding */
  searchOnAdd?: boolean;
}

export interface ServiceConfig {
  enabled: boolean;
  /** URL the AIO server uses to reach the service (usually the docker hostname). */
  url: string;
  /** URL your browser uses to open the service (e.g. https://jellyfin.example.com). */
  publicUrl: string;
  apiKey: string;
  username: string;
  password: string;
  defaults: ServiceDefaults;
  /** Jellyfin: user whose "continue watching" / "recently added" rows are shown when not logged in via Jellyfin. */
  userId: string;
}

export type ImportMode = 'auto' | 'hardlink' | 'copy' | 'move';

export interface PathMapping {
  /** Path as reported by the download client */
  from: string;
  /** Same location as seen inside the AIO container */
  to: string;
}

export interface Settings {
  general: {
    title: string;
    /** Allow signing in with Jellyfin accounts. */
    jellyfinLogin: 'off' | 'admins' | 'all';
    /** Which client receives torrents / NZBs grabbed from the indexer search ('' = first enabled). */
    torrentClient: ClientId | '';
    usenetClient: ClientId | '';
    /** Category prefix used for direct grabs: aio-music, aio-audiobooks, aio-files ... */
    categoryPrefix: string;
  };
  services: Record<ServiceId, ServiceConfig>;
  clients: Record<ClientId, ServiceConfig>;
  paths: {
    /** Folders shown in the Files browser (completed downloads). */
    downloads: string[];
    /** Where downloaded music is placed (library folder of Navidrome / Jellyfin music). */
    music: string;
    /** Where downloaded audiobooks are placed (Audiobookshelf library folder). */
    audiobooks: string;
    /** Download-client path -> AIO container path translations. */
    mappings: PathMapping[];
    importMode: ImportMode;
  };
}

export const SECRET_MASK = '••••••••';
const SECRET_FIELDS = new Set(['apiKey', 'password']);

function emptyService(id: ServiceId | ClientId): ServiceConfig {
  return {
    enabled: false,
    url: DEFAULT_URLS[id],
    publicUrl: '',
    apiKey: '',
    username: '',
    password: '',
    defaults: { searchOnAdd: true },
    userId: '',
  };
}

export function defaultSettings(): Settings {
  const services = Object.fromEntries(SERVICE_IDS.map((id) => [id, emptyService(id)])) as Record<ServiceId, ServiceConfig>;
  services.sonarr.defaults = { searchOnAdd: true, monitor: 'all', seriesType: 'standard' };
  services.radarr.defaults = { searchOnAdd: true, minimumAvailability: 'released' };
  services.lidarr.defaults = { searchOnAdd: true, monitor: 'all' };
  services.readarr.defaults = { searchOnAdd: true, monitor: 'all' };
  const clients = Object.fromEntries(CLIENT_IDS.map((id) => [id, emptyService(id)])) as Record<ClientId, ServiceConfig>;
  clients.nzbget.username = 'nzbget';
  return {
    general: {
      title: 'AIO Arr',
      jellyfinLogin: 'off',
      torrentClient: '',
      usenetClient: '',
      categoryPrefix: 'aio',
    },
    services,
    clients,
    paths: {
      downloads: [],
      music: '',
      audiobooks: '',
      mappings: [],
      importMode: 'auto',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || (process.env.NODE_ENV === 'production' ? '/config' : './data'));
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

export function configPath(...parts: string[]): string {
  return path.join(CONFIG_DIR, ...parts);
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : structuredClone(v);
  }
  return out as T;
}

function getAt(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function setAt(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteAt(obj: Record<string, unknown>, dotted: string): void {
  const keys = dotted.split('.');
  let cur: unknown = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur)) return;
    cur = cur[k];
  }
  if (isPlainObject(cur)) delete cur[keys[keys.length - 1]];
}

const truthy = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());

export function trimUrl(u: string): string {
  return (u || '').trim().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* Environment overrides                                               */
/* ------------------------------------------------------------------ */

interface EnvOverride {
  path: string;
  value: unknown;
}

export function envOverrides(env: NodeJS.ProcessEnv = process.env): EnvOverride[] {
  const out: EnvOverride[] = [];
  const add = (p: string, value: unknown) => out.push({ path: p, value });
  const str = (name: string) => {
    const v = env[name];
    return v !== undefined && v !== '' ? v : undefined;
  };

  const svc = (group: 'services' | 'clients', id: ServiceId | ClientId) => {
    const P = id.toUpperCase();
    const url = str(`${P}_URL`);
    if (url) add(`${group}.${id}.url`, trimUrl(url));
    const pub = str(`${P}_PUBLIC_URL`);
    if (pub) add(`${group}.${id}.publicUrl`, trimUrl(pub));
    const key = str(`${P}_API_KEY`) ?? str(`${P}_APIKEY`);
    if (key) add(`${group}.${id}.apiKey`, key.trim());
    const user = str(`${P}_USERNAME`) ?? str(`${P}_USER`);
    if (user) add(`${group}.${id}.username`, user);
    const pass = str(`${P}_PASSWORD`) ?? str(`${P}_PASS`);
    if (pass) add(`${group}.${id}.password`, pass);
    const enabled = str(`${P}_ENABLED`);
    if (enabled) add(`${group}.${id}.enabled`, truthy(enabled));
    else if (url) add(`${group}.${id}.enabled`, true);
  };
  SERVICE_IDS.forEach((id) => svc('services', id));
  CLIENT_IDS.forEach((id) => svc('clients', id));

  const jfUser = str('JELLYFIN_USER_ID');
  if (jfUser) add('services.jellyfin.userId', jfUser);

  const title = str('APP_TITLE');
  if (title) add('general.title', title);
  const jfLogin = str('JELLYFIN_LOGIN');
  if (jfLogin && ['off', 'admins', 'all'].includes(jfLogin)) add('general.jellyfinLogin', jfLogin);
  const tc = str('TORRENT_CLIENT');
  if (tc && (CLIENT_IDS as readonly string[]).includes(tc)) add('general.torrentClient', tc);
  const uc = str('USENET_CLIENT');
  if (uc && (CLIENT_IDS as readonly string[]).includes(uc)) add('general.usenetClient', uc);
  const prefix = str('CATEGORY_PREFIX');
  if (prefix) add('general.categoryPrefix', prefix);

  const downloads = str('DOWNLOADS_PATHS') ?? str('DOWNLOADS_PATH');
  if (downloads) add('paths.downloads', downloads.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  const music = str('MUSIC_PATH');
  if (music) add('paths.music', music.trim());
  const audiobooks = str('AUDIOBOOKS_PATH');
  if (audiobooks) add('paths.audiobooks', audiobooks.trim());
  const mappings = str('PATH_MAPPINGS');
  if (mappings) {
    // "/downloads:/data/torrents,/remote/path:/local/path"
    const list = mappings
      .split(/[,;]/)
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        // skip the colon of a Windows drive letter ("C:\downloads:/data")
        const idx = pair.indexOf(':', /^[A-Za-z]:[\\/]/.test(pair) ? 2 : 1);
        return idx > 0 ? { from: pair.slice(0, idx).trim(), to: pair.slice(idx + 1).trim() } : null;
      })
      .filter((m): m is PathMapping => !!m && !!m.from && !!m.to);
    add('paths.mappings', list);
  }
  const importMode = str('IMPORT_MODE');
  if (importMode && ['auto', 'hardlink', 'copy', 'move'].includes(importMode)) add('paths.importMode', importMode);
  return out;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/**
 * SETTINGS_FROM_ENV=override (default): environment variables win and are shown read-only in the UI.
 * SETTINGS_FROM_ENV=seed: environment variables only initialise settings.json on first start; afterwards the UI owns them.
 */
const seedMode = () => (process.env.SETTINGS_FROM_ENV || 'override').toLowerCase() === 'seed';

const events = new EventEmitter();
let fileSettings: Record<string, unknown> = {};
let effective: Settings = defaultSettings();
let locked: string[] = [];

function recompute(): void {
  let s = deepMerge(defaultSettings(), fileSettings);
  const overrides = seedMode() ? [] : envOverrides();
  for (const o of overrides) setAt(s as unknown as Record<string, unknown>, o.path, o.value);
  locked = overrides.map((o) => o.path);
  // normalise
  for (const group of [s.services, s.clients] as Record<string, ServiceConfig>[]) {
    for (const cfg of Object.values(group)) {
      cfg.url = trimUrl(cfg.url);
      cfg.publicUrl = trimUrl(cfg.publicUrl);
    }
  }
  s.paths.downloads = (s.paths.downloads || []).map((p) => p.trim()).filter(Boolean);
  effective = s;
}

export function loadSettings(): Settings {
  ensureConfigDir();
  const exists = fs.existsSync(SETTINGS_FILE);
  try {
    if (exists) {
      fileSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
    }
  } catch (err) {
    log.error(`Could not read ${SETTINGS_FILE}, starting with defaults`, err);
    fileSettings = {};
  }
  if (!exists && seedMode()) {
    const seeded: Record<string, unknown> = {};
    for (const o of envOverrides()) setAt(seeded, o.path, o.value);
    fileSettings = seeded;
    persist();
    log.info('Settings initialised from environment variables (SETTINGS_FROM_ENV=seed) - edit them in the web UI from now on');
  }
  recompute();
  return effective;
}

export function getSettings(): Settings {
  return effective;
}

export function lockedPaths(): string[] {
  return [...locked];
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  events.on('change', fn);
  return () => events.off('change', fn);
}

export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/**
 * Apply a partial settings object coming from the UI.
 * - fields locked by environment variables are ignored
 * - masked secrets keep their stored value
 */
export function updateSettings(patch: unknown): Settings {
  if (!isPlainObject(patch)) throw new Error('Invalid settings payload');
  const clean = structuredClone(patch) as Record<string, unknown>;
  // Drop secrets that were sent back masked
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) walk(v, p);
      else if (SECRET_FIELDS.has(k) && v === SECRET_MASK) delete obj[k];
    }
  };
  walk(clean, '');
  for (const p of locked) deleteAt(clean, p);
  fileSettings = deepMerge(fileSettings, clean);
  persist();
  recompute();
  events.emit('change', effective);
  return effective;
}

function persist(): void {
  ensureConfigDir();
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(fileSettings, null, 2));
}

/** Settings safe to send to the browser: secrets masked. */
export function maskedSettings(s: Settings = effective): Settings {
  const copy = structuredClone(s);
  for (const group of [copy.services, copy.clients] as Record<string, ServiceConfig>[]) {
    for (const cfg of Object.values(group)) {
      if (cfg.apiKey) cfg.apiKey = SECRET_MASK;
      if (cfg.password) cfg.password = SECRET_MASK;
    }
  }
  return copy;
}

/** Resolve a (possibly masked) service config coming from the UI against stored values. */
export function resolveServiceConfig(group: 'services' | 'clients', id: string, incoming: Partial<ServiceConfig>): ServiceConfig {
  const stored = (getAt(effective, `${group}.${id}`) as ServiceConfig | undefined) ?? emptyService(id as ServiceId);
  const merged: ServiceConfig = { ...stored, ...incoming, defaults: { ...stored.defaults, ...(incoming.defaults || {}) } };
  if (incoming.apiKey === SECRET_MASK) merged.apiKey = stored.apiKey;
  if (incoming.password === SECRET_MASK) merged.password = stored.password;
  merged.url = trimUrl(merged.url);
  merged.publicUrl = trimUrl(merged.publicUrl);
  return merged;
}

/** Internal: for tests */
export function _setFileSettingsForTest(data: Record<string, unknown>): void {
  fileSettings = data;
  recompute();
}

