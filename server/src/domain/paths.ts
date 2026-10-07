/* Path translation between download clients and this container, plus file-name helpers. */
import path from 'node:path';
import { getSettings } from '../config.js';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Translate a path reported by a download client into the path inside the AIO container. */
export function mapClientPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const input = norm(p);
  const mappings = [...getSettings().paths.mappings].sort((a, b) => norm(b.from).length - norm(a.from).length);
  for (const m of mappings) {
    const from = norm(m.from);
    if (!from) continue;
    if (input === from || input.startsWith(`${from}/`) || (/^[a-z]:/i.test(from) && input.toLowerCase().startsWith(`${from.toLowerCase()}/`))) {
      return norm(m.to) + input.slice(from.length);
    }
  }
  return input;
}

/** Make a string safe to use as a single folder / file name on any filesystem. */
export function safeName(s: string, max = 180): string {
  const cleaned = s
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  return (cleaned || 'download').slice(0, max).trim();
}

export interface ParsedRelease {
  artist?: string;
  title: string;
  year?: number;
}

/** "Andy Weir - Project Hail Mary (2021) [MP3 64kbps]" -> { artist: "Andy Weir", title: "Project Hail Mary", year: 2021 } */
export function parseReleaseName(name: string): ParsedRelease {
  let s = name.replace(/\.(mp3|flac|m4a|m4b|zip|rar|7z|epub|pdf|mobi|azw3|cbz|cbr)$/i, '');
  if (!s.includes(' ') && /[._]/.test(s)) s = s.replace(/[._]+/g, ' ');
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(s);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  s = s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\(([^)]*)\)/g, (m, inner: string) =>
      /(19|20)\d{2}|mp3|flac|m4b|aac|ogg|opus|web|cd|vinyl|unabridged|abridged|audio ?book|kbps|vbr|lossless|\bv0\b|\b320\b|retail|deluxe edition|remaster/i.test(inner)
        ? ' '
        : m,
    )
    .replace(/\b(FLAC|MP3|M4B|AAC|WEB|CD|VBR|320|V0|16bit|24bit|44\.1kHz|Unabridged|Audiobook|Retail)\b/gi, ' ')
    .replace(/-[A-Za-z0-9]+$/, (m) => (/^-[A-Z0-9]{2,}$/.test(m) ? ' ' : m)) // scene group suffix
    .replace(/\b(19|20)\d{2}\b\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-–\s]+$/, '');
  const dash = s.split(/\s+[-–]\s+/);
  if (dash.length >= 2) {
    return { artist: dash[0].trim(), title: dash.slice(1).join(' - ').trim() || s, year };
  }
  return { title: s || name, year };
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
