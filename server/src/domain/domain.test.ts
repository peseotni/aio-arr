import { describe, expect, it } from 'vitest';
import { _setFileSettingsForTest, envOverrides } from '../config.js';
import { mapClientPath, parseReleaseName, safeName, isInside } from './paths.js';
import { detectKind } from './grabs.js';
import { localImage, sizedRemote, movieItem, seriesItem } from './media.js';

describe('path mapping', () => {
  it('maps the longest matching prefix and leaves others alone', () => {
    _setFileSettingsForTest({
      paths: {
        mappings: [
          { from: '/downloads', to: '/data/torrents' },
          { from: '/downloads/complete', to: '/data/usenet/complete' },
          { from: 'D:\\Downloads', to: '/mnt/d' },
        ],
      },
    });
    expect(mapClientPath('/downloads/complete/Album')).toBe('/data/usenet/complete/Album');
    expect(mapClientPath('/downloads/x.iso')).toBe('/data/torrents/x.iso');
    expect(mapClientPath('/downloadsX/file')).toBe('/downloadsX/file');
    expect(mapClientPath('D:\\Downloads\\Some App\\setup.exe')).toBe('/mnt/d/Some App/setup.exe');
    _setFileSettingsForTest({});
  });

  it('builds safe names', () => {
    expect(safeName('AC/DC: Back in Black? <2020>')).toBe('AC DC Back in Black 2020');
    expect(safeName('...')).toBe('download');
  });

  it('checks containment', () => {
    expect(isInside('/data/a/b', '/data/a')).toBe(true);
    expect(isInside('/data/a', '/data/a')).toBe(true);
    expect(isInside('/data/ab', '/data/a')).toBe(false);
    expect(isInside('/data/a/../b', '/data/a')).toBe(false);
  });
});

describe('release name parsing', () => {
  it('splits author / title and drops tags', () => {
    expect(parseReleaseName('Andy Weir - Project Hail Mary (2021) [MP3 64kbps] Unabridged')).toEqual({ artist: 'Andy Weir', title: 'Project Hail Mary', year: 2021 });
    expect(parseReleaseName('Daft Punk - Discovery (2001) [FLAC]')).toEqual({ artist: 'Daft Punk', title: 'Discovery', year: 2001 });
    expect(parseReleaseName('Daft_Punk-Discovery-WEB-2001-FLAC').title).toBeTruthy();
    expect(parseReleaseName('SomeBook.m4b')).toEqual({ title: 'SomeBook', year: undefined });
  });
});

describe('grab kind detection', () => {
  it('uses newznab categories', () => {
    expect(detectKind([{ id: 3030, name: 'Audio/Audiobook' }])).toBe('audiobook');
    expect(detectKind([{ id: 3040, name: 'Audio/Lossless' }])).toBe('music');
    expect(detectKind([{ id: 100023, name: 'Audiobooks' }])).toBe('audiobook');
    expect(detectKind([{ id: 4050, name: 'PC/Games' }])).toBe('files');
    expect(detectKind([{ id: 7020, name: 'Books/EBook' }])).toBe('files');
    expect(detectKind([])).toBe('files');
  });
});

describe('environment overrides', () => {
  it('reads service settings and lists', () => {
    const o = envOverrides({
      RADARR_URL: 'http://radarr:7878/',
      RADARR_API_KEY: 'abc',
      QBITTORRENT_URL: 'http://gluetun:8080',
      QBITTORRENT_ENABLED: 'false',
      DOWNLOADS_PATHS: '/data/torrents, /data/usenet',
      PATH_MAPPINGS: '/downloads:/data/torrents;C:\\dl:/mnt/c',
    } as NodeJS.ProcessEnv);
    const get = (p: string) => o.find((x) => x.path === p)?.value;
    expect(get('services.radarr.url')).toBe('http://radarr:7878');
    expect(get('services.radarr.enabled')).toBe(true);
    expect(get('services.radarr.apiKey')).toBe('abc');
    expect(get('clients.qbittorrent.enabled')).toBe(false);
    expect(get('paths.downloads')).toEqual(['/data/torrents', '/data/usenet']);
    expect(get('paths.mappings')).toEqual([
      { from: '/downloads', to: '/data/torrents' },
      { from: 'C:\\dl', to: '/mnt/c' },
    ]);
  });
});

describe('media normalisation', () => {
  it('proxies local artwork and resizes TMDB images', () => {
    expect(localImage('radarr', '/MediaCover/12/poster.jpg?lastWrite=1', 500)).toBe('/api/artwork/radarr/12/poster-500.jpg?lastWrite=1');
    expect(localImage('lidarr', '/lidarr/MediaCover/Albums/7/cover.jpg', 250)).toBe('/api/artwork/lidarr/album/7/cover-250.jpg');
    expect(localImage('radarr', 'https://image.tmdb.org/x.jpg')).toBeUndefined();
    expect(sizedRemote('http://image.tmdb.org/t/p/original/abc.jpg', 'poster')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
  });

  it('derives availability', () => {
    expect(movieItem({ id: 1, tmdbId: 5, title: 'A', hasFile: true }).availability).toBe('available');
    expect(movieItem({ id: 1, tmdbId: 5, title: 'A', hasFile: false, isAvailable: false, status: 'announced' }).availability).toBe('unreleased');
    expect(movieItem({ tmdbId: 5, title: 'A' }).availability).toBe('none');
    const s = seriesItem({ id: 3, tvdbId: 9, title: 'S', statistics: { episodeFileCount: 4, episodeCount: 10 } });
    expect(s.availability).toBe('partial');
    expect(s.progress).toEqual({ have: 4, total: 10, percent: 40 });
  });
});
