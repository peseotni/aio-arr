import type { FastifyInstance } from 'fastify';
import { HttpError } from '../util/http.js';
import { deletePath, fileRoots, listDir, resolveAllowed, sendPath } from '../domain/files.js';
import { importAudio } from '../domain/grabs.js';
import { services } from '../services/registry.js';
import { bool, body, query, requireAdmin, str } from './util.js';

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/files/roots', async () => fileRoots());

  app.get('/api/files/list', async (req) => listDir(str(query(req).path, 'path', { max: 4096 })));

  // never compress: keeps Content-Length / Range intact for large downloads
  app.get('/api/files/download', { compress: false }, async (req, reply) => {
    const q = query(req);
    return sendPath(req, reply, str(q.path, 'path', { max: 4096 }), bool(q.inline));
  });

  app.delete('/api/files', async (req) => {
    requireAdmin(req);
    await deletePath(str(query(req).path, 'path', { max: 4096 }));
    return { ok: true };
  });

  // Put a downloaded folder into the music / audiobook library by hand
  app.post('/api/files/import', async (req) => {
    requireAdmin(req);
    const b = body(req);
    const kind = b.kind === 'audiobook' ? 'audiobook' : b.kind === 'music' ? 'music' : undefined;
    if (!kind) throw new HttpError('kind must be "music" or "audiobook"', 400);
    const { real } = await resolveAllowed(str(b.path, 'path', { max: 4096 }));
    const res = await importAudio(real, kind, 'local');
    const s = services();
    await Promise.allSettled([
      kind === 'music' ? s.navidrome?.startScan() : s.audiobookshelf?.scanForPath(res.dest),
      s.jellyfin?.notifyPaths([res.dest]),
    ]);
    return res;
  });
}
