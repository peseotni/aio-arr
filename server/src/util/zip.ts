/*
 * Streaming ZIP writer (stored, no compression - media is already compressed).
 * Supports ZIP64 and knows the exact archive size up front, so browsers can show progress.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface ZipEntry {
  /** Name inside the archive (forward slashes). */
  name: string;
  /** File on disk */
  path: string;
  size: number;
  mtime: Date;
}

interface Planned extends ZipEntry {
  nameBuf: Buffer;
  offset: number;
  zip64: boolean;
  crc: number;
}

export interface ZipPlan {
  entries: Planned[];
  totalSize: number;
  cdOffset: number;
  cdSize: number;
  zip64End: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0808; // bit 3: data descriptor, bit 11: UTF-8 names
const VERSION_MADE_BY = (3 << 8) | 45; // UNIX, spec 4.5

function dos(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function planZip(entries: ZipEntry[]): ZipPlan {
  let offset = 0;
  const planned: Planned[] = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const zip64 = e.size >= MAX32 || offset >= MAX32;
    const p: Planned = { ...e, nameBuf, offset, zip64, crc: 0 };
    offset += 30 + nameBuf.length + (zip64 ? 20 : 0) + e.size + (zip64 ? 24 : 16);
    return p;
  });
  const cdOffset = offset;
  const cdSize = planned.reduce((n, p) => n + 46 + p.nameBuf.length + (p.zip64 ? 28 : 0), 0);
  const zip64End = planned.length >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  return { entries: planned, cdOffset, cdSize, zip64End, totalSize: cdOffset + cdSize + (zip64End ? 56 + 20 : 0) + 22 };
}

function localHeader(p: Planned): Buffer {
  const { time, date } = dos(p.mtime);
  const extraLen = p.zip64 ? 20 : 0;
  const b = Buffer.alloc(30 + p.nameBuf.length + extraLen);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(p.zip64 ? 45 : 20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(0, 8); // stored
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(0, 14); // crc in data descriptor
  b.writeUInt32LE(p.zip64 ? MAX32 : 0, 18);
  b.writeUInt32LE(p.zip64 ? MAX32 : 0, 22);
  b.writeUInt16LE(p.nameBuf.length, 26);
  b.writeUInt16LE(extraLen, 28);
  p.nameBuf.copy(b, 30);
  if (p.zip64) {
    const o = 30 + p.nameBuf.length;
    b.writeUInt16LE(0x0001, o);
    b.writeUInt16LE(16, o + 2);
    b.writeBigUInt64LE(0n, o + 4);
    b.writeBigUInt64LE(0n, o + 12);
  }
  return b;
}

function dataDescriptor(p: Planned): Buffer {
  if (p.zip64) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x08074b50, 0);
    b.writeUInt32LE(p.crc >>> 0, 4);
    b.writeBigUInt64LE(BigInt(p.size), 8);
    b.writeBigUInt64LE(BigInt(p.size), 16);
    return b;
  }
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(p.crc >>> 0, 4);
  b.writeUInt32LE(p.size, 8);
  b.writeUInt32LE(p.size, 12);
  return b;
}

function centralHeader(p: Planned): Buffer {
  const { time, date } = dos(p.mtime);
  const extraLen = p.zip64 ? 28 : 0;
  const b = Buffer.alloc(46 + p.nameBuf.length + extraLen);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(VERSION_MADE_BY, 4);
  b.writeUInt16LE(p.zip64 ? 45 : 20, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(p.crc >>> 0, 16);
  b.writeUInt32LE(p.zip64 ? MAX32 : p.size, 20);
  b.writeUInt32LE(p.zip64 ? MAX32 : p.size, 24);
  b.writeUInt16LE(p.nameBuf.length, 28);
  b.writeUInt16LE(extraLen, 30);
  b.writeUInt16LE(0, 32); // comment
  b.writeUInt16LE(0, 34); // disk
  b.writeUInt16LE(0, 36); // internal attrs
  b.writeUInt32LE(((0o100644 << 16) >>> 0) as number, 38);
  b.writeUInt32LE(p.zip64 ? MAX32 : p.offset, 42);
  p.nameBuf.copy(b, 46);
  if (p.zip64) {
    const o = 46 + p.nameBuf.length;
    b.writeUInt16LE(0x0001, o);
    b.writeUInt16LE(24, o + 2);
    b.writeBigUInt64LE(BigInt(p.size), o + 4);
    b.writeBigUInt64LE(BigInt(p.size), o + 12);
    b.writeBigUInt64LE(BigInt(p.offset), o + 20);
  }
  return b;
}

function endRecords(plan: ZipPlan): Buffer {
  const n = plan.entries.length;
  const parts: Buffer[] = [];
  if (plan.zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(VERSION_MADE_BY, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(n), 24);
    z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(plan.cdSize), 40);
    z.writeBigUInt64LE(BigInt(plan.cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(plan.cdOffset + plan.cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(0, 4);
  e.writeUInt16LE(0, 6);
  e.writeUInt16LE(Math.min(n, MAX16), 8);
  e.writeUInt16LE(Math.min(n, MAX16), 10);
  e.writeUInt32LE(Math.min(plan.cdSize, MAX32), 12);
  e.writeUInt32LE(Math.min(plan.cdOffset, MAX32), 16);
  e.writeUInt16LE(0, 20);
  parts.push(e);
  return Buffer.concat(parts);
}

export async function* zipStream(plan: ZipPlan): AsyncGenerator<Buffer> {
  for (const p of plan.entries) {
    yield localHeader(p);
    let crc = 0;
    let written = 0;
    if (p.size > 0) {
      for await (const chunk of fs.createReadStream(p.path, { highWaterMark: 1 << 20, end: p.size - 1 })) {
        const buf = chunk as Buffer;
        crc = zlib.crc32(buf, crc);
        written += buf.length;
        yield buf;
      }
    }
    if (written !== p.size) throw new Error(`File changed while zipping: ${p.name}`);
    p.crc = crc;
    yield dataDescriptor(p);
  }
  for (const p of plan.entries) yield centralHeader(p);
  yield endRecords(plan);
}
