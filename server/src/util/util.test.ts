import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { magnetInfoHash, torrentInfoHash, torrentName, looksLikeNzb, looksLikeTorrent } from './torrent.js';
import { planZip, zipStream } from './zip.js';
import { buildQuery, extractErrorMessage, joinUrl } from './http.js';
import { parseHms } from '../services/clients/types.js';

function bencode(v: unknown): Buffer {
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (typeof v === 'string' || Buffer.isBuffer(v)) {
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(obj[k])]), Buffer.from('e')]);
}

describe('torrent helpers', () => {
  const info = { length: 12345, name: 'Some Album [FLAC]', 'piece length': 16384, pieces: Buffer.alloc(20, 7) };
  const file = bencode({ announce: 'http://tracker/announce', 'creation date': 1700000000, info });

  it('computes the v1 info hash of a .torrent', () => {
    const expected = crypto.createHash('sha1').update(bencode(info)).digest('hex');
    expect(torrentInfoHash(file)).toBe(expected);
    expect(torrentName(file)).toBe('Some Album [FLAC]');
    expect(looksLikeTorrent(file)).toBe(true);
  });

  it('rejects garbage', () => {
    expect(torrentInfoHash(Buffer.from('<html>nope</html>'))).toBeUndefined();
    expect(torrentInfoHash(Buffer.from('d4:info'))).toBeUndefined();
  });

  it('reads hex and base32 magnet hashes', () => {
    expect(magnetInfoHash('magnet:?xt=urn:btih:0123456789ABCDEF0123456789abcdef01234567&dn=x')).toBe('0123456789abcdef0123456789abcdef01234567');
    // base32 of 20 bytes 0x00..0x13
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    let b32 = '';
    for (let i = 0; i < bits.length; i += 5) b32 += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${b32}`)).toBe(bytes.toString('hex'));
    expect(magnetInfoHash('magnet:?dn=nohash')).toBeUndefined();
  });

  it('detects nzb files', () => {
    expect(looksLikeNzb(Buffer.from('<?xml version="1.0"?><!DOCTYPE nzb><nzb xmlns="x"></nzb>'))).toBe(true);
    expect(looksLikeNzb(file)).toBe(false);
  });
});

describe('zip writer', () => {
  it('produces an archive of exactly the announced size that unzip accepts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-zip-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), crypto.randomBytes(300_000));
    fs.writeFileSync(path.join(dir, 'sub', 'empty'), '');
    fs.writeFileSync(path.join(dir, 'ünïcødé ✓.txt'), 'utf8 name');
    const files = ['a.txt', 'sub/b.bin', 'sub/empty', 'ünïcødé ✓.txt'].map((rel) => {
      const p = path.join(dir, rel);
      const st = fs.statSync(p);
      return { name: `folder/${rel}`, path: p, size: st.size, mtime: st.mtime };
    });
    const plan = planZip(files);
    const chunks: Buffer[] = [];
    for await (const c of zipStream(plan)) chunks.push(c);
    const zip = Buffer.concat(chunks);
    expect(zip.length).toBe(plan.totalSize);
    const out = path.join(dir, 'out.zip');
    fs.writeFileSync(out, zip);
    // Python's zipfile verifies CRCs and sizes
    const report = execFileSync('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print(bad); print("\\n".join(i.filename+"|"+str(i.file_size) for i in z.infolist()))',
      out,
    ]).toString();
    const [bad, ...entries] = report.trim().split('\n');
    expect(bad).toBe('None');
    expect(entries).toEqual(files.map((f) => `${f.name}|${f.size}`));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('switches to zip64 for big offsets', () => {
    const plan = planZip([
      { name: 'big.bin', path: '/dev/null', size: 5 * 1024 ** 3, mtime: new Date() },
      { name: 'small.txt', path: '/dev/null', size: 10, mtime: new Date() },
    ]);
    expect(plan.entries[0].zip64).toBe(true);
    expect(plan.entries[1].zip64).toBe(true); // offset > 4GiB
    expect(plan.zip64End).toBe(true);
  });
});

describe('http helpers', () => {
  it('joins urls with url bases', () => {
    expect(joinUrl('http://host:7878/radarr/', '/api/v3/movie')).toBe('http://host:7878/radarr/api/v3/movie');
    expect(joinUrl('http://host:9091/transmission/rpc', '')).toBe('http://host:9091/transmission/rpc');
  });

  it('builds queries with arrays and skips empties', () => {
    expect(buildQuery({ a: 1, b: undefined, c: '', d: [3000, 3030], e: false })).toBe('?a=1&d=3000&d=3030&e=false');
  });

  it('extracts readable errors', () => {
    expect(extractErrorMessage('[{"propertyName":"Path","errorMessage":"Path already exists"}]', 400)).toBe('Path already exists');
    expect(
      extractErrorMessage(
        JSON.stringify({ message: 'Search failed.', description: 'System.Exception: boom\n ---> inner\n   at Foo.Bar()' }),
        500,
      ),
    ).toBe('Search failed.');
    expect(extractErrorMessage('<html><body><h1>502 Bad Gateway</h1></body></html>', 502)).toBe('502 Bad Gateway');
  });

  it('parses SABnzbd time left', () => {
    expect(parseHms('0:12:34')).toBe(754);
    expect(parseHms('1:02:03:04')).toBe(93784);
    expect(parseHms('12:34')).toBe(754);
    expect(parseHms('bad')).toBeNull();
  });
});
