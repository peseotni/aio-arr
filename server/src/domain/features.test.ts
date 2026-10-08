import { describe, expect, it } from 'vitest';
import { _setFileSettingsForTest, envOverrides } from '../config.js';
import { parseRelease } from './parse.js';
import { destinationFor } from './grabs.js';
import { classify, parseCategories, torznabFor } from './categories.js';
import { createConfig, guessOldDefaults, networkPlan } from './recreate.js';
import { titleScore } from './artwork.js';
import { identifyApp } from './updates.js';
import { AUTO_ORDER, PLAYER_SUPPORT, contentOf } from './players.js';
import { JellyfinService } from '../services/jellyfin.js';
import { PlexService } from '../services/plex.js';
import { NavidromeService } from '../services/audio.js';
import { recItem } from '../services/discover.js';
import { splitRef } from '../services/docker.js';

const p = (name: string, type: Parameters<typeof parseRelease>[1]) => {
  const r = parseRelease(name, type);
  return { title: r.title, year: r.year, artist: r.artist, detail: r.detail };
};

describe('release parsing', () => {
  it('movies', () => {
    expect(p('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', 'movies')).toMatchObject({ title: 'Dune Part Two', year: 2024 });
    expect(p('2001.A.Space.Odyssey.1968.1080p.BluRay.x264-AMIABLE', 'movies')).toMatchObject({ title: '2001 A Space Odyssey', year: 1968 });
    expect(p('Blade Runner 2049 (2017) [2160p] [4K] [WEB]', 'movies')).toMatchObject({ title: 'Blade Runner 2049', year: 2017 });
    expect(p("Charlotte's Web 2006 1080p WEBRip x265", 'movies')).toMatchObject({ title: "Charlotte's Web", year: 2006 });
    expect(p('1917.2019.1080p.BluRay.x264', 'movies')).toMatchObject({ title: '1917', year: 2019 });
    expect(p('Sintel.2010.1080p.BluRay.x264-MOCK', 'movies')).toMatchObject({ title: 'Sintel', year: 2010 });
  });

  it('tv', () => {
    expect(p('The.Bear.S03E01.1080p.WEB.h264-ETHEL', 'tv')).toMatchObject({ title: 'The Bear', detail: 'S03E01' });
    expect(p('Breaking Bad (2008) Season 1-5 Complete 1080p', 'tv')).toMatchObject({ title: 'Breaking Bad', year: 2008, detail: 'Season 1' });
    expect(p('Doctor.Who.2005.S13E01.720p.HDTV', 'tv')).toMatchObject({ title: 'Doctor Who', year: 2005, detail: 'S13E01' });
    expect(p('Pioneer.One.S01.720p.WEB', 'tv')).toMatchObject({ title: 'Pioneer One', detail: 'Season 1' });
  });

  it('music and books', () => {
    expect(p('Daft Punk - Discovery (2001) [FLAC 24-96]', 'music')).toMatchObject({ artist: 'Daft Punk', title: 'Discovery', year: 2001 });
    expect(p('Daft_Punk-Discovery-CD-FLAC-2001-PERFECT', 'music')).toMatchObject({ artist: 'Daft Punk', title: 'Discovery', year: 2001 });
    expect(p('Andy Weir - Project Hail Mary (2021) [MP3 64kbps] Unabridged', 'audiobooks')).toMatchObject({ artist: 'Andy Weir', title: 'Project Hail Mary' });
    expect(p('Project Hail Mary by Andy Weir [EPUB]', 'ebooks')).toMatchObject({ artist: 'Andy Weir', title: 'Project Hail Mary' });
    expect(p('Stand by Me (epub)', 'ebooks')).toMatchObject({ title: 'Stand by Me' });
    expect(p('The Pragmatic Programmer 20th Anniversary EPUB', 'ebooks')).toMatchObject({ title: 'The Pragmatic Programmer' });
    expect(p('Clean Code - 2nd Edition (2025) [EPUB]', 'ebooks')).toMatchObject({ title: 'Clean Code' });
    // library folders: Author/Title, else a clean title
    expect(destinationFor('ebook', '/lib', 'Cory Doctorow - Walkaway (2017) [EPUB]', true).dir).toBe('/lib/Cory Doctorow/Walkaway');
    expect(destinationFor('ebook', '/lib', 'The Pragmatic Programmer 20th Anniversary EPUB', true).dir).toBe('/lib/The Pragmatic Programmer');
    expect(destinationFor('comic', '/lib', 'Pepper.and.Carrot.003.2016.Digital-MOCK', true)).toEqual({ dir: '/lib/Pepper and Carrot', flat: true });
  });

  it('comics', () => {
    expect(p('Saga 001 (2012) (Digital) (Empire)', 'comics')).toMatchObject({ title: 'Saga', year: 2012, detail: '#001' });
    expect(p('Batman v3 050 (2018) (Webrip) (The Last Kryptonian-DCP)', 'comics')).toMatchObject({ title: 'Batman v3', year: 2018, detail: '#050' });
    expect(p('The Walking Dead Vol. 01 - Days Gone Bye (2004)', 'comics')).toMatchObject({ title: 'The Walking Dead', detail: 'Vol. 1' });
    expect(p('Pepper.and.Carrot.003.2016.Digital-MOCK', 'comics')).toMatchObject({ title: 'Pepper and Carrot', year: 2016, detail: '#003' });
  });

  it('games and software', () => {
    expect(p('Elden.Ring.Shadow.of.the.Erdtree-RUNE', 'games')).toMatchObject({ title: 'Elden Ring Shadow of the Erdtree' });
    expect(p('Cyberpunk 2077 v2.12 [FitGirl Repack]', 'games')).toMatchObject({ title: 'Cyberpunk 2077', detail: 'v2.12' });
    expect(p('Baldurs.Gate.3.v4.1.1.3767641-GOG', 'games').title).toBe('Baldurs Gate 3');
    expect(p('Hogwarts Legacy Deluxe Edition (v1105) [DODI Repack]', 'games').title).toBe('Hogwarts Legacy');
    expect(p('Super Mario Bros Wonder NSW-SUXXORS', 'games')).toMatchObject({ title: 'Super Mario Bros Wonder', detail: 'Switch' });
    expect(p("Marvel's Spider-Man Remastered v1.817.1.0", 'games').title).toBe("Marvel's Spider-Man Remastered");
    expect(p('Adobe Photoshop 2024 v25.5.1 (x64) Multilingual', 'software')).toMatchObject({ title: 'Adobe Photoshop 2024', detail: 'v25.5.1' });
    expect(p('Blender 4.5 Portable x64', 'software').title).toBe('Blender');
    expect(p('Microsoft.Office.2021.Pro.Plus.v2108.Build.14332.20447', 'software').title).toBe('Microsoft Office 2021 Plus');
  });

  it('groups releases of the same thing under one key', () => {
    expect(parseRelease('Dune.Part.Two.2024.1080p.WEB-DL', 'movies').key).toBe(parseRelease('Dune Part Two (2024) [2160p]', 'movies').key);
    expect(parseRelease('The.Bear.S03E01.1080p', 'tv').key).toBe(parseRelease('The Bear S02E05 720p', 'tv').key);
    expect(parseRelease('Saga 001 (2012)', 'comics').key).toBe(parseRelease('Saga 054 (2018) (Digital)', 'comics').key);
  });
});

describe('search categories', () => {
  it('classifies indexer results', () => {
    expect(classify([{ id: 2000 }, { id: 2040 }])).toBe('movies');
    expect(classify([{ id: 5070, name: 'TV/Anime' }])).toBe('tv');
    expect(classify([{ id: 3000 }, { id: 3030 }])).toBe('audiobooks');
    expect(classify([{ id: 7000 }, { id: 7030 }])).toBe('comics');
    expect(classify([{ id: 7020 }])).toBe('ebooks');
    expect(classify([{ id: 4000 }, { id: 4050 }])).toBe('games');
    expect(classify([{ id: 1080 }])).toBe('games');
    expect(classify([{ id: 4030, name: 'PC/Mac' }])).toBe('software');
    expect(classify([{ id: 100512, name: 'Manga' }])).toBe('comics');
    expect(classify([{ id: 8010 }])).toBe('other');
  });

  it('parses the selection', () => {
    expect(parseCategories('movies,bogus,tv,movies')).toEqual(['movies', 'tv']);
    expect(parseCategories('')).toHaveLength(9);
    expect(torznabFor(['games', 'software'])).toEqual([1000, 4050, 4000]);
  });
});

describe('container recreation', () => {
  const info = {
    Id: 'abcdef123456' + '0'.repeat(52),
    Name: '/radarr',
    Image: 'sha256:old',
    State: { Running: true },
    Config: {
      Hostname: 'abcdef123456',
      Image: 'lscr.io/linuxserver/radarr:latest',
      Env: ['PUID=1000', 'TZ=Europe/Amsterdam', 'PATH=/usr/bin', 'HOME=/root'],
      Cmd: null,
      Entrypoint: ['/init'],
      Labels: { 'com.docker.compose.service': 'radarr', 'com.docker.compose.image': 'sha256:old', maintainer: 'lsio', build_version: '1' },
      ExposedPorts: { '7878/tcp': {} },
      Volumes: { '/config': {} },
      WorkingDir: '/',
      Healthcheck: null,
    },
    HostConfig: { Binds: ['/srv/radarr:/config', '/data:/data'], NetworkMode: 'arr', RestartPolicy: { Name: 'unless-stopped' } },
    Mounts: [
      { Type: 'bind', Source: '/srv/radarr', Destination: '/config', RW: true },
      { Type: 'volume', Name: 'e3b0c442', Destination: '/cache', RW: true },
    ],
    NetworkSettings: {
      Networks: {
        arr: { Aliases: ['radarr', 'abcdef123456'], IPAMConfig: null },
        proxy: { Aliases: ['radarr'], IPAMConfig: { IPv4Address: '10.0.0.5' } },
      },
    },
  };
  const oldImage = {
    Env: ['PATH=/usr/bin', 'HOME=/root'],
    Entrypoint: ['/init'],
    Labels: { maintainer: 'lsio', build_version: '1' },
    ExposedPorts: { '7878/tcp': {} },
    Volumes: { '/config': {} },
    WorkingDir: '/',
  };

  it('keeps only what you configured and hands over anonymous volumes', () => {
    const c = createConfig(info, 'lscr.io/linuxserver/radarr:latest', oldImage, 'sha256:new');
    expect(c.Image).toBe('lscr.io/linuxserver/radarr:latest');
    expect(c.Hostname).toBeUndefined();
    expect(c.Env).toEqual(['PUID=1000', 'TZ=Europe/Amsterdam']);
    expect(c.Entrypoint).toBeUndefined();
    expect(c.Labels).toEqual({ 'com.docker.compose.service': 'radarr', 'com.docker.compose.image': 'sha256:new' });
    expect(c.ExposedPorts).toBeUndefined();
    expect(c.HostConfig.Binds).toEqual(['/srv/radarr:/config', '/data:/data']);
    expect(c.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'e3b0c442', Target: '/cache', ReadOnly: false }]);
  });

  it('without the old image, lets the new image own versions, labels and ports', () => {
    const container = {
      ...info.Config,
      Env: ['PUID=1000', 'TZ=Europe/Amsterdam', 'PATH=/usr/bin', 'APP_VERSION=1.0', 'NODE_ENV=production'],
      Labels: { ...info.Config.Labels, 'org.opencontainers.image.version': '1.0' },
    };
    const newImage = { Env: ['PATH=/usr/local/bin:/usr/bin', 'APP_VERSION=1.1', 'NODE_ENV=production', 'TZ=Etc/UTC'], Labels: { maintainer: 'lsio', 'org.opencontainers.image.version': '1.1' }, ExposedPorts: { '7878/tcp': {} } };
    const guess = guessOldDefaults(container, newImage);
    // TZ is defined by the image too, but it is yours: kept
    expect(guess.Env).toEqual(['PATH=/usr/bin', 'APP_VERSION=1.0']);
    const c = createConfig({ ...info, Config: container }, 'lscr.io/linuxserver/radarr:latest', guess, 'sha256:new');
    expect(c.Env).toEqual(['PUID=1000', 'TZ=Europe/Amsterdam', 'NODE_ENV=production']);
    expect(c.Labels).toEqual({ 'com.docker.compose.service': 'radarr', 'com.docker.compose.image': 'sha256:new', build_version: '1' });
    expect(c.ExposedPorts).toBeUndefined();
  });

  it('keeps networks, aliases and fixed addresses', () => {
    const plan = networkPlan(info);
    expect(plan.primary).toEqual({ name: 'arr', endpoint: { Aliases: ['radarr'] } });
    expect(plan.extra).toEqual([{ name: 'proxy', endpoint: { Aliases: ['radarr'], IPAMConfig: { IPv4Address: '10.0.0.5' } } }]);
    expect(networkPlan({ ...info, HostConfig: { NetworkMode: 'container:gluetun' } })).toEqual({ extra: [] });
  });

  it('splits image references', () => {
    expect(splitRef('lscr.io/linuxserver/radarr:latest')).toEqual({ name: 'lscr.io/linuxserver/radarr', tag: 'latest' });
    expect(splitRef('localhost:5000/app')).toEqual({ name: 'localhost:5000/app', tag: 'latest' });
    expect(splitRef('jellyfin/jellyfin')).toEqual({ name: 'jellyfin/jellyfin', tag: 'latest' });
    expect(splitRef('nginx@sha256:abc')).toEqual({ name: 'nginx', tag: 'sha256:abc' });
  });

  it('recognises apps by image', () => {
    expect(identifyApp('lscr.io/linuxserver/radarr:latest', 'movies').app).toBe('radarr');
    expect(identifyApp('plexinc/pms-docker:latest', 'x').app).toBe('plex');
    expect(identifyApp('ghcr.io/hotio/qbittorrent:release', 'qb').app).toBe('qbittorrent');
    expect(identifyApp('fallenbagel/jellyseerr', 'requests').app).toBe('jellyseerr');
    expect(identifyApp('postgres:16', 'db').app).toBeUndefined();
  });
});

describe('open with', () => {
  it('maps content to apps that can open it', () => {
    expect(contentOf('album')).toBe('music');
    expect(contentOf('series')).toBe('tv');
    for (const [type, apps] of Object.entries(AUTO_ORDER)) for (const a of apps) expect(PLAYER_SUPPORT[a]).toContain(type);
  });

  it('reads OPEN_<TYPE>_WITH and new folders from the environment', () => {
    const o = envOverrides({ OPEN_MOVIES_WITH: 'plex', OPEN_COMICS_WITH: 'nonsense', COMICS_PATH: '/data/media/comics', TMDB_API_KEY: 'k' } as NodeJS.ProcessEnv);
    const get = (path: string) => o.find((x) => x.path === path)?.value;
    expect(get('players.movies')).toBe('plex');
    expect(get('players.comics')).toBeUndefined();
    expect(get('paths.comics')).toBe('/data/media/comics');
    expect(get('services.tmdb.enabled')).toBe(true);
    expect(envOverrides({ PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 't0k' } as NodeJS.ProcessEnv).find((x) => x.path === 'services.plex.apiKey')?.value).toBe('t0k');
    _setFileSettingsForTest({});
  });
});

describe('library indexes', () => {
  it('Jellyfin / Emby: ids first, then title + year for films', () => {
    const idx = JellyfinService.buildIndexFrom([
      { Id: 'a', Type: 'Movie', Name: 'Sintel', ProductionYear: 2010, ProviderIds: { Tmdb: '45745' } },
      { Id: 'b', Type: 'Series', Name: 'Pioneer One', ProductionYear: 2010, ProviderIds: { Tvdb: '170551' } },
      { Id: 'c', Type: 'Movie', Name: 'Big Buck Bunny', ProductionYear: 2008, ProviderIds: {} },
    ]);
    expect(JellyfinService.lookup(idx, { type: 'Movie', tmdb: 45745 })?.id).toBe('a');
    expect(JellyfinService.lookup(idx, { type: 'Series', tvdb: 170551 })?.id).toBe('b');
    expect(JellyfinService.lookup(idx, { type: 'Movie', name: 'Big Buck Bunny', year: 2008 })?.id).toBe('c');
    expect(JellyfinService.lookup(idx, { type: 'Movie', name: 'Big Buck Bunny' })).toBeUndefined();
  });

  it('Plex: Guid arrays and album names', () => {
    const idx = PlexService.buildIndexFrom([
      { ratingKey: '10', type: 'movie', title: 'The Matrix', year: 1999, Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }] },
      { ratingKey: '11', type: 'show', title: 'Breaking Bad', year: 2008, Guid: [{ id: 'tvdb://81189' }] },
      { ratingKey: '12', type: 'album', title: 'Discovery', parentTitle: 'Daft Punk', guid: 'local://12' },
      { ratingKey: '13', type: 'movie', title: 'Sintel', year: 2010, guid: 'local://13' },
    ]);
    expect(PlexService.lookup(idx, { type: 'movie', tmdb: 603 })?.ratingKey).toBe('10');
    expect(PlexService.lookup(idx, { type: 'movie', imdb: 'tt0133093' })?.ratingKey).toBe('10');
    expect(PlexService.lookup(idx, { type: 'show', tvdb: 81189 })?.ratingKey).toBe('11');
    expect(PlexService.lookup(idx, { type: 'album', name: 'Discovery', artist: 'Daft Punk' })?.ratingKey).toBe('12');
    expect(PlexService.lookup(idx, { type: 'movie', tmdb: 45745, name: 'Sintel', year: 2010 })?.ratingKey).toBe('13');
    const web = (publicUrl: string) => new PlexService('plex', 'Plex', { enabled: true, url: 'http://plex:32400', publicUrl, apiKey: 't', username: '', password: '', userId: '', defaults: {} }).publicUrl;
    expect(web('')).toBe('https://app.plex.tv/desktop');
    expect(web('https://app.plex.tv/desktop')).toBe('https://app.plex.tv/desktop');
    expect(web('http://192.168.1.10:32400')).toBe('http://192.168.1.10:32400/web/index.html');
    expect(web('https://plex.example.com/web/')).toBe('https://plex.example.com/web/index.html');
  });

  it('Navidrome: artists by MusicBrainz id, albums by artist + title', () => {
    const idx = NavidromeService.buildIndexFrom(
      [{ id: 'al1', name: 'Discovery', artist: 'Daft Punk', musicBrainzId: 'release-id' }],
      [{ id: 'ar1', name: 'Daft Punk', musicBrainzId: '056e4f3e-d505-4dad-8ec1-d04f521cbb56' }],
    );
    expect(NavidromeService.lookup(idx, { type: 'artist', mb: '056E4F3E-D505-4DAD-8EC1-D04F521CBB56', name: 'x' })).toBe('ar1');
    expect(NavidromeService.lookup(idx, { type: 'album', name: 'Discovery', artist: 'Daft Punk' })).toBe('al1');
  });
});

describe('recommendation and artwork helpers', () => {
  it('normalises TMDB and Jellyseerr results', () => {
    expect(recItem({ id: 603, title: 'The Matrix', release_date: '1999-03-30', poster_path: '/p.jpg', vote_average: 8.2 }, 'movie')).toMatchObject({
      tmdbId: 603,
      year: 1999,
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      rating: 8.2,
    });
    expect(recItem({ id: 1396, name: 'Breaking Bad', firstAirDate: '2008-01-20', posterPath: '/b.jpg' }, 'series')).toMatchObject({ title: 'Breaking Bad', year: 2008 });
    expect(recItem({ id: 0, title: 'x' }, 'movie')).toBeUndefined();
  });

  it('scores title matches', () => {
    expect(titleScore('Dune Part Two', 'Dune: Part Two')).toBe(1);
    expect(titleScore('Hollow Knight', 'Hollow Knight (video game)')).toBe(1);
    expect(titleScore('Saga', 'Saga, Vol. 1')).toBeGreaterThanOrEqual(0.6);
    expect(titleScore('Saga', 'The Twilight Saga')).toBeLessThan(0.6);
  });
});
