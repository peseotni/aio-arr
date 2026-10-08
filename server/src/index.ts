import fs from 'node:fs';
import { loadSettings, CONFIG_DIR, ensureConfigDir } from './config.js';
import { authConfig, bootstrapAdminFromEnv, hasUsers } from './auth.js';
import { buildApp } from './app.js';
import { startPostProcessor, stopPostProcessor } from './domain/grabs.js';
import { startUpdateChecker } from './domain/updates.js';
import { dockerTarget } from './services/docker.js';
import { log } from './log.js';
import { VERSION } from './version.js';

/** When started as root with PUID/PGID set (the docker image sets 1000), continue as that user. */
function dropPrivileges(): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.env.PUID === undefined) return;
  const uid = Number(process.env.PUID);
  const gid = Number(process.env.PGID ?? process.env.PUID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return;
  // keep access to a mounted Docker socket (one-click updates) through its group
  const groups = [gid];
  const sock = dockerTarget()?.socketPath;
  if (sock) {
    try {
      const sockGid = fs.statSync(sock).gid;
      if (!groups.includes(sockGid)) groups.push(sockGid);
    } catch {
      /* not there */
    }
  }
  try {
    process.setgroups?.(groups);
    process.setgid!(gid);
    process.setuid!(uid);
    log.info(`Running as uid ${uid}, gid ${gid}${groups.length > 1 ? ` (+ group ${groups[1]} for the Docker socket)` : ''}`);
  } catch (err) {
    log.warn(`Could not switch to PUID ${uid} / PGID ${gid}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  dropPrivileges();
  ensureConfigDir();
  loadSettings();
  bootstrapAdminFromEnv();

  const app = await buildApp();
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen({ port, host });

  log.info(`AIO Arr ${VERSION} listening on http://${host}:${port} (config: ${CONFIG_DIR}, auth: ${authConfig.mode})`);
  if (authConfig.mode === 'local' && !hasUsers()) {
    log.warn('No accounts yet - open the web UI to create the admin account (or set ADMIN_USERNAME / ADMIN_PASSWORD).');
  }
  if (authConfig.mode === 'none') log.warn('AUTH_MODE=none: anyone who can reach this port has full access.');

  startPostProcessor();
  startUpdateChecker();

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopPostProcessor();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal('Failed to start', err);
  process.exit(1);
});
