import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  if (process.env.AIO_VERSION) return process.env.AIO_VERSION;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) return String(v);
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
