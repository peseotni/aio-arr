import type { ServiceConfig } from '../config.js';
import { httpRequest, type HttpTarget, type RequestOptions } from '../util/http.js';

export interface TestResult {
  ok: true;
  version?: string;
  message: string;
}

export abstract class BaseService implements HttpTarget {
  constructor(
    public readonly id: string,
    public readonly name: string,
    protected readonly cfg: ServiceConfig,
  ) {}

  get baseUrl(): string {
    return this.cfg.url;
  }

  /** URL to open in the browser. */
  get publicUrl(): string {
    return this.cfg.publicUrl || this.cfg.url;
  }

  get config(): ServiceConfig {
    return this.cfg;
  }

  headers(): Record<string, string> | Promise<Record<string, string>> {
    return {};
  }

  request<T = any>(path: string, opts?: RequestOptions): Promise<T> {
    return httpRequest<T>(this, path, opts);
  }

  abstract test(): Promise<TestResult>;
}
