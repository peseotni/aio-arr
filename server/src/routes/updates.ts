import type { FastifyInstance } from 'fastify';
import { HttpError } from '../util/http.js';
import { docker } from '../services/docker.js';
import { checkForUpdates, startUpdate, updateJob, updatesOverview } from '../domain/updates.js';
import { params, requireAdmin } from './util.js';

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  // updating containers means control over Docker: admins only
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/updates')) requireAdmin(req);
  });

  app.get('/api/updates', async () => updatesOverview());

  app.post('/api/updates/check', async () => {
    await checkForUpdates();
    return updatesOverview();
  });

  // update everything that has an update (AIO Arr itself last, it restarts)
  app.post('/api/updates/all', async () => {
    const overview = await updatesOverview();
    const todo = overview.apps.filter((a) => a.state === 'available').sort((a, b) => Number(!!a.self) - Number(!!b.self));
    return todo.map((a) => startUpdate(a.id, a.name));
  });

  app.get('/api/updates/jobs/:id', async (req) => updateJob(params(req).id));

  app.post('/api/updates/:id', async (req) => {
    const d = docker();
    if (!d) throw new HttpError('AIO Arr has no access to Docker - see Settings > Updates', 409);
    const id = params(req).id;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw new HttpError('Invalid container', 400);
    const info = await d.inspect(id).catch(() => undefined);
    if (!info?.Id) throw new HttpError('Container not found', 404);
    return startUpdate(info.Id, String(info.Name || id).replace(/^\//, ''));
  });
}
