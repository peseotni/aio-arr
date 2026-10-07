/* Tiny JSON-file persistence with atomic writes. Good enough for users, grabs and similar small state. */
import fs from 'node:fs';
import { configPath, ensureConfigDir, writeFileAtomic } from './config.js';
import { moduleLogger } from './log.js';

const log = moduleLogger('store');

export class JsonStore<T> {
  private data: T | undefined;
  private readonly file: string;

  constructor(
    name: string,
    private readonly defaults: () => T,
  ) {
    this.file = configPath(name);
  }

  read(): T {
    if (this.data === undefined) {
      try {
        this.data = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as T) : this.defaults();
      } catch (err) {
        log.error(`Could not parse ${this.file}; a backup is kept as .corrupt`, err);
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt`);
        } catch {
          /* ignore */
        }
        this.data = this.defaults();
      }
    }
    return this.data;
  }

  write(data: T): void {
    ensureConfigDir();
    this.data = data;
    writeFileAtomic(this.file, JSON.stringify(data, null, 2));
  }

  update(fn: (draft: T) => void): T {
    const draft = structuredClone(this.read());
    fn(draft);
    this.write(draft);
    return draft;
  }
}
