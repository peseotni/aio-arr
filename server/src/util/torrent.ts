/* Just enough bencode to compute a torrent's info-hash, and magnet link parsing. */
import crypto from 'node:crypto';

/** Returns [start, end) byte offsets of the bencoded value starting at `pos`. */
function skipValue(buf: Buffer, pos: number): number {
  const c = buf[pos];
  if (c === 0x69 /* i */) {
    const end = buf.indexOf(0x65 /* e */, pos);
    if (end < 0) throw new Error('bad int');
    return end + 1;
  }
  if (c === 0x6c /* l */ || c === 0x64 /* d */) {
    let p = pos + 1;
    while (buf[p] !== 0x65) {
      if (p >= buf.length) throw new Error('unterminated container');
      p = skipValue(buf, p);
    }
    return p + 1;
  }
  if (c >= 0x30 && c <= 0x39) {
    const colon = buf.indexOf(0x3a /* : */, pos);
    if (colon < 0) throw new Error('bad string');
    const len = Number(buf.subarray(pos, colon).toString('ascii'));
    if (!Number.isFinite(len) || len < 0) throw new Error('bad string length');
    return colon + 1 + len;
  }
  throw new Error(`unexpected byte 0x${(c ?? 0).toString(16)} at ${pos}`);
}

function readString(buf: Buffer, pos: number): [string, number] {
  const colon = buf.indexOf(0x3a, pos);
  const len = Number(buf.subarray(pos, colon).toString('ascii'));
  const start = colon + 1;
  return [buf.subarray(start, start + len).toString('latin1'), start + len];
}

/** SHA-1 info hash (v1) of a .torrent file, lowercase hex. Returns undefined for invalid data. */
export function torrentInfoHash(buf: Buffer): string | undefined {
  try {
    if (buf[0] !== 0x64) return undefined;
    let p = 1;
    while (p < buf.length && buf[p] !== 0x65) {
      const [key, next] = readString(buf, p);
      const valueEnd = skipValue(buf, next);
      if (key === 'info') return crypto.createHash('sha1').update(buf.subarray(next, valueEnd)).digest('hex');
      p = valueEnd;
    }
  } catch {
    /* invalid */
  }
  return undefined;
}

/** Extract the name ("info.name") of a .torrent, if present. */
export function torrentName(buf: Buffer): string | undefined {
  try {
    let p = 1;
    while (p < buf.length && buf[p] !== 0x65) {
      const [key, next] = readString(buf, p);
      const valueEnd = skipValue(buf, next);
      if (key === 'info' && buf[next] === 0x64) {
        let q = next + 1;
        while (q < valueEnd - 1) {
          const [k2, n2] = readString(buf, q);
          const e2 = skipValue(buf, n2);
          if (k2 === 'name' && buf[n2] >= 0x30 && buf[n2] <= 0x39) return Buffer.from(readString(buf, n2)[0], 'latin1').toString('utf8');
          q = e2;
        }
      }
      p = valueEnd;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s: string): string | undefined {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return undefined;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

/** Lowercase hex v1 info-hash from a magnet link. */
export function magnetInfoHash(magnet: string): string | undefined {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet);
  if (!m) return undefined;
  const v = m[1];
  if (/^[a-fA-F0-9]{40}$/.test(v)) return v.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(v)) return base32ToHex(v);
  return undefined;
}

export function looksLikeTorrent(buf: Buffer): boolean {
  return buf.length > 10 && buf[0] === 0x64 && buf.includes(Buffer.from('4:info'));
}

export function looksLikeNzb(buf: Buffer): boolean {
  const head = buf.subarray(0, 2048).toString('utf8').toLowerCase();
  return head.includes('<nzb') || (head.includes('<?xml') && head.includes('nzb'));
}
