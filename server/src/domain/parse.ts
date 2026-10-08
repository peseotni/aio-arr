/*
 * Release names -> clean titles, per category:
 *   "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1-FLUX"          -> Dune Part Two (2024)
 *   "The.Bear.S03E01.1080p.WEB.h264-ETHEL"                 -> The Bear · S03E01
 *   "Saga 001 (2012) (Digital) (Empire)"                    -> Saga · #001
 *   "Baldurs.Gate.3.v4.1.1.3767641-GOG"                     -> Baldurs Gate 3 · v4.1.1
 *   "Adobe Photoshop 2024 v25.5.1 (x64) Multilingual"       -> Adobe Photoshop 2024
 * Used to group indexer results by what they are and to look up cover art.
 */
import type { ContentType, ParsedTitle } from '../types.js';

const FILE_EXT =
  /\.(mkv|mp4|m4v|avi|mov|wmv|ts|iso|img|bin|zip|rar|7z|tar|gz|epub|pdf|mobi|azw3?|fb2|djvu|cbz|cbr|cb7|cbt|flac|mp3|m4a|m4b|aac|ogg|opus|exe|msi|dmg|pkg|apk|nsp|xci|torrent|nzb)$/i;

/** Video "tech" tokens: everything from the first one on is not part of the title. */
const VIDEO_TECH =
  /\b(2160p|1440p|1080[pi]|720p|576p|480p|360p|4k|uhd|hdr(10)?(plus|\+)?|dv|dovi|sdr|web[ -]?dl|web[ -]?rip|web|webrip|amzn|nf|dsnp|hmax|atvp|hulu|blu[ -]?ray|bdrip|brrip|bd(25|50|66|100)?|remux|hdtv|pdtv|dvd(rip|scr|5|9|r)?|hddvd|xvid|divx|x264|x265|h[ .]?26[45]|hevc|avc|av1|vp9|aac(2[ .]0)?|ac3|eac3|dts(-?hd)?(-?ma)?|ddp?(5[ .]1|2[ .]0|7[ .]1)?|atmos|truehd|flac|opus|10bit|8bit|proper|repack|rerip|extended|unrated|uncut|imax|remastered|internal|limited|multi|dual(-audio)?|dubbed|subbed|hardsub|hc|cam|hdcam|telesync|telecine|complete|criterion|directors?[ .]cut)\b/i;

const GAME_NOISE =
  /\b(nsw|nsp|xci|switch|ps[2345]|ps vita|psp|pkg|xbox( one| series [xs])?|x360|xb1|wii ?u?|3ds|nds|gba|pc|win(dows)?(64|32)?|mac(os| os)?|osx|linux|gog|steam|steamrip|elamigos|dodi|fitgirl|kaos|repack|rip|portable|multi\d*|eng|iso|crack(ed)?|cracksnow|codex|plaza|cpy|skidrow|reloaded|razor1911|tenoke|rune|flt|doge|empress|p2p|incl(uding)?|dlcs?|update|hotfix|patch|proper|internal|retail|nogrp|goty|(digital |game of the year |deluxe |complete |ultimate |premium |definitive |gold |standard |collectors? |anniversary |enhanced |special |legendary |director'?s |remastered )+edition|v\d+(\.\d+)*[a-z]?|build[ .]?\d+(?:[ .]\d+)*)\b/gi;

const SOFTWARE_NOISE =
  /\b(x64|x86|x32|amd64|arm64|aarch64|64[ -]?bit|32[ -]?bit|win(dows)?( ?(7|8|10|11|xp))?|win64|win32|mac(os| os)?|osx|linux|ubuntu|debian|multilingual|multilang|multi|english|portable|pre[ -]?activated|preactivated|activated|repack|retail|crack(ed)?|keygen|patch(ed)?|serial|final|setup|installer|incl(uding)?|iso|full|version|edition|pro(fessional)?|ultimate|enterprise|business|home|standard|lite|beta|alpha|rc\d*|lts|stable|release|update|build[ .]?\d+(?:[ .]\d+)*|v\d+(\.\d+)*[a-z]?|\d+(\.\d+){1,3}[a-z]?)\b/gi;

const BOOK_NOISE =
  /\b(epub|mobi|azw3?|pdf|fb2|djvu|retail|unabridged|abridged|audiobook|audio book|mp3|m4b|aac|flac|\d+ ?kbps|vbr|cbr|read by|narrated by|ebook|e-book|kindle|true pdf|scan|ocr|illustrated)\b/gi;

/** "20th Anniversary Edition", "2nd Edition", "Revised Edition" - not part of the title */
const BOOK_EDITION =
  /\b(\d+(st|nd|rd|th)\s+anniversary(\s+edition)?|(\d+(st|nd|rd|th)|first|second|third|fourth|fifth|sixth|revised|updated|expanded|special|collectors?|deluxe|anniversary|illustrated|annotated)\s+edition)\b/gi;

export function norm(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '')
    .trim();

/** Dots / underscores as spaces when the name has no spaces ("The.Bear.S03E01"); keeps version dots (v4.1.1, 5.1). */
function spaced(name: string): string {
  let s = name.trim().replace(FILE_EXT, '');
  if (!/\s/.test(s) && /[._]/.test(s)) {
    s = s.replace(/_/g, ' ');
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '.') {
        out += c;
        continue;
      }
      // version numbers (v4.1.1, 25.5, 5.1) keep their dots; issue numbers (003.2016) and years don't
      const run = /(\d+)$/.exec(s.slice(0, i))?.[1] || '';
      const keep = run.length >= 1 && run.length <= 3 && (run === '0' || !run.startsWith('0')) && /\d/.test(s[i + 1] || '');
      out += keep ? '.' : ' ';
    }
    s = out;
  }
  return s.replace(/_/g, ' ');
}

/** "Name-GROUP" scene suffix: no space before the dash and the token looks like a group (RUNE, NTb, playWEB). */
function dropGroup(s: string): string {
  return s.replace(/(\S)-([A-Za-z0-9]{2,24})\s*$/, (m, before: string, tok: string) =>
    /^[A-Z0-9]+$/.test(tok) || /[a-z][A-Z]/.test(tok) || /\d/.test(tok) || /^[a-z]+$/.test(tok) ? before : m,
  );
}

const yearIn = (s: string): number | undefined => {
  const m = /\b(19[2-9]\d|20[0-4]\d)\b/.exec(s);
  return m ? Number(m[1]) : undefined;
};

/** Tokens that only appear in release tags (never in titles). */
const STRONG_TECH =
  /\b(2160p|1440p|1080[pi]|720p|576p|480p|360p|uhd|web[ -]?dl|web[ -]?rip|webrip|blu[ -]?ray|bdrip|brrip|bd(25|50|66|100)|remux|hdtv|pdtv|dvdrip|dvdscr|hddvd|xvid|divx|x26[45]|h[ .]?26[45]|hevc|av1|10bit|ddp?5[ .]1|aac2[ .]0)\b/i;

function parseVideo(s: string, type: 'movies' | 'tv'): Omit<ParsedTitle, 'key'> {
  const work = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  let season: number | undefined;
  let episode: number | undefined;
  let detail: string | undefined;
  let year: number | undefined;
  let cut = -1;
  const ep = /\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[-E]\d{1,3})*\b|\b(\d{1,2})x(\d{2})\b/i.exec(work);
  const pack = /\bS(\d{1,2})\b(?![ ._-]?E\d)|\bSeason[ ._-]?(\d{1,2})\b/i.exec(work);
  if (ep) {
    season = Number(ep[1] ?? ep[3]);
    episode = Number(ep[2] ?? ep[4]);
    detail = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    cut = ep.index;
  } else if (pack) {
    season = Number(pack[1] ?? pack[2]);
    detail = `Season ${season}`;
    cut = pack.index;
  } else if (type === 'tv') {
    const daily = /\b(20\d{2})[ .-](\d{2})[ .-](\d{2})\b/.exec(work);
    if (daily) {
      detail = `${daily[1]}-${daily[2]}-${daily[3]}`;
      cut = daily.index;
    }
  }
  if (cut < 0) {
    // the release year closes the title: the last year before the first tag ("2001 A Space Odyssey 1968 1080p")
    const firstTag = STRONG_TECH.exec(work)?.index ?? work.length;
    const years = [...work.matchAll(/\(?\b(19[2-9]\d|20[0-4]\d)\b\)?/g)].filter((m) => m.index! > 0 && m.index! < firstTag && tidy(work.slice(0, m.index)).length > 0);
    const y = years[years.length - 1];
    if (y) {
      year = Number(y[1]);
      cut = y.index!;
    } else {
      const tag = STRONG_TECH.exec(work) || VIDEO_TECH.exec(work);
      if (tag && tag.index > 0) cut = tag.index;
    }
  }
  let head = cut >= 0 ? work.slice(0, cut) : dropGroup(work);
  if (!year) {
    // "Doctor Who 2005 S13E01", "Breaking Bad (2008) Season 1"
    const paren = /\((19[2-9]\d|20[0-4]\d)\)/.exec(head);
    const trailing = /\s(19[2-9]\d|20[0-4]\d)\s*$/.exec(head);
    if (paren) {
      year = Number(paren[1]);
      head = head.slice(0, paren.index) + head.slice(paren.index + paren[0].length);
    } else if (trailing && tidy(head.slice(0, trailing.index)).length > 0) {
      year = Number(trailing[1]);
      head = head.slice(0, trailing.index);
    }
  }
  return { title: tidy(head.replace(/\([^)]*\)/g, ' ')) || tidy(s), year, season, episode, detail };
}

function parseMusic(s: string, raw: string): Omit<ParsedTitle, 'key'> {
  let work = s;
  // scene style without spaces: Daft_Punk-Discovery-CD-FLAC-2001-PERFECT, Artist_-_Album-(CAT1)-WEB-2023-GRP
  const bare = raw.trim().replace(FILE_EXT, '');
  if (!/\s/.test(bare) && (bare.match(/-/g) || []).length >= 2) {
    const parts = bare
      .split('-')
      .map((p) => p.replace(/_/g, ' ').replace(/\./g, ' ').trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      const year = parts.map((p) => (/^(19|20)\d{2}$/.test(p) ? Number(p) : undefined)).find(Boolean);
      return { artist: tidy(parts[0]), title: tidy(parts[1].replace(/\([^)]*\)/g, ' ')), year };
    }
  }
  const year = yearIn(work);
  work = work
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\(([^)]*)\)/g, (m, inner: string) =>
      /(19|20)\d{2}|mp3|flac|aac|ogg|opus|web|cd|vinyl|lossless|kbps|vbr|v0|320|24[ -]?bit|16[ -]?bit|hi-?res|remaster|deluxe|edition|expanded|anniversary|single|ep\b|lp\b/i.test(inner) ? ' ' : m,
    )
    .replace(/\b(FLAC|MP3|AAC|WEB|CD|VBR|320|V0|16bit|24bit|24-96|24-192|44\.1kHz|Lossless|Hi-?Res|Discography)\b/gi, ' ');
  work = dropGroup(work).replace(/\b(19|20)\d{2}\b\s*$/, ' ');
  const dash = work.split(/\s+[-–]\s+/).map(tidy).filter(Boolean);
  if (dash.length >= 2) return { artist: dash[0], title: dash.slice(1).join(' - '), year };
  return { title: tidy(work) || tidy(s), year };
}

function parseBook(s: string): Omit<ParsedTitle, 'key'> {
  const year = yearIn(s);
  let work = s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\(([^)]*)\)/g, (m, inner: string) => (/(19|20)\d{2}|epub|mobi|pdf|azw|retail|unabridged|abridged|mp3|m4b|kbps|narrated|read by|audible|ebook/i.test(inner) ? ' ' : m))
    .replace(BOOK_NOISE, ' ')
    .replace(BOOK_EDITION, ' ');
  work = dropGroup(work).replace(/\b(19|20)\d{2}\b\s*$/, ' ');
  const by = /^(.+?)\s+by\s+((?:[A-Z][\w.'-]*\s+){1,3}[A-Z][\w.'-]*)$/.exec(tidy(work));
  if (by) return { title: tidy(by[1]), artist: tidy(by[2]), year };
  const dash = work.split(/\s+[-–]\s+/).map(tidy).filter(Boolean);
  if (dash.length >= 2) return { artist: dash[0], title: dash.slice(1).join(' - '), year };
  return { title: tidy(work) || tidy(s), year };
}

function parseComic(s: string): Omit<ParsedTitle, 'key'> {
  let year: number | undefined;
  let work = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    const y = /^(19|20)\d{2}$/.exec(inner.trim());
    if (y && !year) year = Number(y[0]);
    return ' ';
  });
  work = dropGroup(work.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')).replace(/\b(digital|webrip|c2c|scan|hd|upscaled|cbz|cbr|pdf|epub)\b/gi, ' ');
  if (!year) {
    const y = /\s(19|20)\d{2}\s*$/.exec(work);
    if (y) {
      year = Number(y[0].trim());
      work = work.slice(0, y.index);
    }
  }
  let detail: string | undefined;
  // "Vol. 01 - Days Gone Bye", "Volume 3", "TPB", "#12", "050", "v3 050"
  const vol = /\b(?:vol(?:ume)?\.?\s?|tpb\s?|book\s)(\d{1,3})\b(.*)$/i.exec(work);
  if (vol) {
    detail = `Vol. ${Number(vol[1])}`;
    work = work.slice(0, vol.index);
  } else {
    const issue = /\s#?(\d{1,4}(?:\.\d)?)(?:\s*\(of \d+\))?\s*$/i.exec(work);
    if (issue) {
      detail = `#${issue[1]}`;
      work = work.slice(0, issue.index);
    }
  }
  return { title: tidy(work) || tidy(s), year, detail };
}

function parseGame(s: string): Omit<ParsedTitle, 'key'> {
  const platforms: string[] = [];
  const PLATFORM: [RegExp, string][] = [
    [/\b(nsw|nsp|xci|switch)\b/i, 'Switch'],
    [/\bps5\b/i, 'PS5'],
    [/\bps4\b/i, 'PS4'],
    [/\bxbox\b/i, 'Xbox'],
    [/\b(mac ?os|osx)\b/i, 'macOS'],
    [/\blinux\b/i, 'Linux'],
  ];
  for (const [re, label] of PLATFORM) if (re.test(s)) platforms.push(label);
  const version = /\bv(\d+(?:\.\d+)+[a-z]?)\b/i.exec(s)?.[1];
  let year: number | undefined;
  let work = s
    .replace(/\(([^)]*)\)/g, (_m, inner: string) => {
      const y = /^(19|20)\d{2}$/.exec(inner.trim());
      if (y) year = Number(y[0]);
      return ' ';
    })
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
  work = dropGroup(work)
    .replace(/[+&]\s*\d*\s*(dlcs?|bonus(es)?|updates?)\b.*$/i, ' ')
    .replace(/\b(update|patch|hotfix)\b.*$/i, ' ')
    .replace(GAME_NOISE, ' ')
    .replace(/\s[-–]\s*$/, ' ');
  const detail = [platforms.join(' / '), version ? `v${version}` : ''].filter(Boolean).join(' · ') || undefined;
  return { title: tidy(work) || tidy(s), year, detail };
}

function parseSoftware(s: string): Omit<ParsedTitle, 'key'> {
  const version = /\bv?(\d+(?:\.\d+){1,3}[a-z]?)\b/i.exec(s.replace(/\b(19|20)\d{2}\b/g, ''))?.[1];
  let work = s.replace(/\(([^)]*)\)/g, ' ').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
  work = dropGroup(work).replace(/[+&]\s*(crack|keygen|patch|serial|activator).*$/i, ' ').replace(SOFTWARE_NOISE, ' ');
  return { title: tidy(work) || tidy(s), detail: version ? `v${version}` : undefined };
}

function parseOther(s: string): Omit<ParsedTitle, 'key'> {
  const work = dropGroup(s.replace(/\[[^\]]*\]|\{[^}]*\}|\([^)]*\)/g, ' '));
  const tech = VIDEO_TECH.exec(work);
  return { title: tidy(tech ? work.slice(0, tech.index) : work) || tidy(s), year: yearIn(s) };
}

/** Clean up a release name for its category. */
export function parseRelease(name: string, type: ContentType, ids?: ParsedTitle['ids']): ParsedTitle {
  const s = spaced(name);
  let p: Omit<ParsedTitle, 'key'>;
  switch (type) {
    case 'movies':
    case 'tv':
      p = parseVideo(s, type);
      break;
    case 'music':
      p = parseMusic(s, name);
      break;
    case 'audiobooks':
    case 'ebooks':
      p = parseBook(s);
      break;
    case 'comics':
      p = parseComic(s);
      break;
    case 'games':
      p = parseGame(s);
      break;
    case 'software':
      p = parseSoftware(s);
      break;
    default:
      p = parseOther(s);
  }
  const keyParts =
    type === 'music' || type === 'audiobooks' || type === 'ebooks'
      ? [norm(p.artist || ''), norm(p.title)]
      : type === 'movies'
        ? [norm(p.title), p.year ? String(p.year) : '']
        : [norm(p.title)];
  const clean = Object.fromEntries(Object.entries({ ...p, ids }).filter(([, v]) => v !== undefined && v !== '')) as Omit<ParsedTitle, 'key'>;
  return { ...clean, key: `${type}:${keyParts.join(':')}` };
}
