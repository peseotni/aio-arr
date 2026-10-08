/* Probe the usual docker hostnames / ports to find services automatically. */
import { CLIENT_IDS, DEFAULT_URLS, SERVICE_IDS, SERVICE_NAMES, type ClientId, type ServiceId } from '../config.js';

export interface Discovered {
  id: ServiceId | ClientId;
  name: string;
  group: 'services' | 'clients';
  url: string;
  version?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  /** What still needs to be filled in by hand */
  note?: string;
}

const EXTRA_CANDIDATES: Partial<Record<ServiceId | ClientId, string[]>> = {
  qbittorrent: ['http://gluetun:8080', 'http://vpn:8080', 'http://qbittorrent:8090', 'http://qbittorrent-vpn:8080'],
  transmission: ['http://gluetun:9091', 'http://transmission-vpn:9091'],
  deluge: ['http://gluetun:8112', 'http://delugevpn:8112'],
  sabnzbd: ['http://sabnzbd:8085', 'http://gluetun:8085'],
  audiobookshelf: ['http://audiobookshelf:13378', 'http://audiobookshelf:8080'],
  jellyfin: ['http://jellyfin:8920'],
  plex: ['http://plexmediaserver:32400', 'http://pms:32400'],
  emby: ['http://embyserver:8096', 'http://emby:8920'],
  komga: ['http://komga:8080'],
  kavita: ['http://kavita:5001'],
  jellyseerr: ['http://overseerr:5055', 'http://jellyseer:5055', 'http://seerr:5055'],
};

const HOST_PORTS: Partial<Record<ServiceId | ClientId, number>> = {
  radarr: 7878,
  sonarr: 8989,
  lidarr: 8686,
  readarr: 8787,
  prowlarr: 9696,
  bazarr: 6767,
  jellyfin: 8096,
  plex: 32400,
  emby: 8096,
  navidrome: 4533,
  audiobookshelf: 13378,
  komga: 25600,
  kavita: 5000,
  jellyseerr: 5055,
  transmission: 9091,
  deluge: 8112,
  nzbget: 6789,
};

async function get(url: string, init: RequestInit = {}): Promise<Response | undefined> {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(2500) });
  } catch {
    return undefined;
  }
}

async function json(res: Response | undefined): Promise<any> {
  if (!res) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function probe(id: ServiceId | ClientId, url: string): Promise<Omit<Discovered, 'id' | 'name' | 'group' | 'url'> | undefined> {
  switch (id) {
    case 'radarr':
    case 'sonarr':
    case 'lidarr':
    case 'readarr':
    case 'prowlarr': {
      const init = await get(`${url}/initialize.json`);
      const data = init?.ok ? await json(init) : undefined;
      if (data?.apiKey) return { apiKey: data.apiKey, version: data.version };
      const ping = await json(await get(`${url}/ping`));
      if (ping?.status === 'OK') return { note: 'Copy the API key from Settings > General' };
      return undefined;
    }
    case 'bazarr': {
      const res = await get(`${url}/api/system/status`);
      return res && (res.status === 401 || res.ok) ? { note: 'Copy the API key from Settings > General' } : undefined;
    }
    case 'jellyfin': {
      const data = await json(await get(`${url}/System/Info/Public`));
      return String(data?.ProductName || '').includes('Jellyfin') ? { version: data.Version, note: 'Create an API key (or sign in below to create one)' } : undefined;
    }
    case 'emby': {
      // Emby answers like Jellyfin but has no "Jellyfin" product name
      const data = await json(await get(`${url}/emby/System/Info/Public`));
      return data?.Id && data?.Version && !String(data?.ProductName || '').includes('Jellyfin')
        ? { version: data.Version, note: 'Create an API key (Settings > Advanced > API Keys, or sign in below)' }
        : undefined;
    }
    case 'plex': {
      const data = await json(await get(`${url}/identity`, { headers: { accept: 'application/json' } }));
      return data?.MediaContainer?.machineIdentifier ? { version: String(data.MediaContainer.version || '').split('-')[0], note: 'Paste your Plex token (X-Plex-Token)' } : undefined;
    }
    case 'komga': {
      const data = await json(await get(`${url}/api/v1/claim`));
      return data && typeof data.isClaimed === 'boolean' ? { note: 'Create an API key in Komga (account settings) or enter your email and password' } : undefined;
    }
    case 'kavita': {
      const res = await get(`${url}/api/health`);
      if (!res?.ok) return undefined;
      const info = await json(await get(`${url}/api/Server/server-info-slim`));
      const text = info ? '' : await res.text().catch(() => '');
      return info?.kavitaVersion || /^ok$/i.test(text.trim()) ? { version: info?.kavitaVersion, note: 'Paste your Kavita API key (user settings)' } : undefined;
    }
    case 'jellyseerr': {
      const data = await json(await get(`${url}/api/v1/status`));
      return data?.version && 'commitTag' in data ? { version: data.version, note: 'Copy the API key from Settings > General' } : undefined;
    }
    case 'tmdb':
      return undefined;
    case 'navidrome': {
      const data = await json(await get(`${url}/rest/ping?f=json&v=1.16.1&c=aio-arr`));
      return data?.['subsonic-response']?.type === 'navidrome' ? { version: data['subsonic-response'].serverVersion, note: 'Enter your Navidrome username and password' } : undefined;
    }
    case 'audiobookshelf': {
      const data = await json(await get(`${url}/status`));
      return data?.app === 'audiobookshelf' ? { version: data.serverVersion, note: 'Paste an API key / token from Audiobookshelf' } : undefined;
    }
    case 'qbittorrent': {
      const res = await get(`${url}/api/v2/app/version`);
      if (!res) return undefined;
      if (res.ok) return { version: (await res.text()).trim(), note: 'Authentication is bypassed for this network' };
      return res.status === 403 || res.status === 401 ? { username: 'admin', note: 'Enter your qBittorrent WebUI password' } : undefined;
    }
    case 'transmission': {
      const res = await get(`${url}/transmission/rpc`, { method: 'POST', body: '{"method":"session-get"}' });
      if (!res) return undefined;
      if (res.status === 409 && res.headers.get('x-transmission-session-id')) return {};
      return res.status === 401 ? { note: 'Enter the Transmission RPC username and password' } : undefined;
    }
    case 'deluge': {
      const res = await get(`${url}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'auth.login', params: ['deluge'], id: 1 }),
      });
      const data = await json(res);
      if (data && 'result' in data) return data.result === true ? { password: 'deluge', note: 'Using the default password "deluge" - change it!' } : { note: 'Enter the Deluge WebUI password' };
      return undefined;
    }
    case 'sabnzbd': {
      const res = await get(`${url}/api?mode=version&output=json`);
      if (!res) return undefined;
      if (res.ok) {
        const data = await json(res);
        return data?.version ? { version: data.version, note: 'Copy the API key from Config > General' } : undefined;
      }
      const text = res.status === 403 ? await res.text().catch(() => '') : '';
      return /sabnzbd|hostname/i.test(text) ? { note: 'Copy the API key from Config > General' } : undefined;
    }
    case 'nzbget': {
      const res = await get(`${url}/jsonrpc`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from('nzbget:tegbzn6789').toString('base64')}` },
        body: JSON.stringify({ method: 'version', params: [], id: 1 }),
      });
      if (!res) return undefined;
      if (res.ok) {
        const data = await json(res);
        if (data?.result) return { version: data.result, username: 'nzbget', password: 'tegbzn6789', note: 'Using the default NZBGet login - change it!' };
      }
      return res.status === 401 ? { note: 'Enter the NZBGet control username and password' } : undefined;
    }
  }
  return undefined;
}

export async function discoverServices(): Promise<Discovered[]> {
  const ids = [...SERVICE_IDS, ...CLIENT_IDS] as (ServiceId | ClientId)[];
  const results = await Promise.all(
    ids.map(async (id) => {
      const candidates = [DEFAULT_URLS[id], ...(EXTRA_CANDIDATES[id] || [])];
      if (HOST_PORTS[id]) candidates.push(`http://host.docker.internal:${HOST_PORTS[id]}`);
      for (const url of candidates) {
        const found = await probe(id, url);
        if (found) {
          return {
            id,
            name: SERVICE_NAMES[id],
            group: (CLIENT_IDS as readonly string[]).includes(id) ? 'clients' : 'services',
            url,
            ...found,
          } as Discovered;
        }
      }
      return undefined;
    }),
  );
  return results.filter((r): r is Discovered => !!r);
}
