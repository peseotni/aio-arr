/* Minimal pino-compatible logger so Fastify and background jobs share one format. */

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LEVELS: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
let threshold = LEVELS[envLevel] ?? LEVELS.info;

function fmtArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export interface Logger {
  level: string;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  silent(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

function createLogger(prefix = ''): Logger {
  const write = (level: Level, args: unknown[]) => {
    if (LEVELS[level] < threshold) return;
    // pino style: first arg may be an object of bindings followed by a message
    let parts: string[];
    if (args.length > 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Error)) {
      const [obj, ...rest] = args as [Record<string, unknown>, ...unknown[]];
      const err = obj.err instanceof Error ? obj.err : undefined;
      parts = rest.map(fmtArg);
      if (err) parts.push(err.stack || err.message);
    } else {
      parts = args.map(fmtArg);
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${parts.join(' ')}`;
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    get level() {
      return (Object.keys(LEVELS) as Level[]).find((k) => LEVELS[k] === threshold) || 'info';
    },
    set level(v: string) {
      threshold = LEVELS[v as Level] ?? threshold;
    },
    trace: (...a) => write('trace', a),
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    fatal: (...a) => write('fatal', a),
    silent: () => {},
    child: (bindings) => {
      const name = typeof bindings.module === 'string' ? `[${bindings.module}] ` : '';
      return createLogger(prefix + name);
    },
  };
}

export const log = createLogger();
export const moduleLogger = (module: string): Logger => log.child({ module });
