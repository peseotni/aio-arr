import type { FastifyRequest } from 'fastify';
import { HttpError } from '../util/http.js';
import type { SessionUser } from '../auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function requireAdmin(req: FastifyRequest): void {
  if (req.user?.role !== 'admin') throw new HttpError('Only administrators can do this', 403);
}

export function body<T = Record<string, unknown>>(req: FastifyRequest): T {
  const b = req.body;
  if (!b || typeof b !== 'object') return {} as T;
  return b as T;
}

export function str(v: unknown, name: string, opts: { optional?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new HttpError(`${name} is required`, 400);
  }
  if (typeof v !== 'string') throw new HttpError(`${name} must be text`, 400);
  if (v.length > (opts.max ?? 4096)) throw new HttpError(`${name} is too long`, 400);
  return v;
}

export function int(v: unknown, name: string, opts: { optional?: boolean } = {}): number {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return NaN;
    throw new HttpError(`${name} is required`, 400);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw new HttpError(`${name} must be a whole number`, 400);
  return n;
}

export function optInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

export function intList(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(Number).filter((n) => Number.isInteger(n));
  return out.length ? out : undefined;
}

export type Q = Record<string, string | undefined>;

export function query(req: FastifyRequest): Q {
  return (req.query || {}) as Q;
}

export function params(req: FastifyRequest): Record<string, string> {
  return (req.params || {}) as Record<string, string>;
}
