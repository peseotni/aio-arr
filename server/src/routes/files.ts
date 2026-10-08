import type { FastifyInstance } from 'fastify';
import { HttpError } from '../util/http.js';
import { deletePath, fileRoots, listDir, resolveAllowed, sendPath } from '../domain/files.js';
import { contentOfKind, importToLibrary, type LibraryKind } from '../domain/grabs.js';
import { invalidatePlayerIndexes, notifyImported } from '../domain/players.js';
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

  // Put a downloaded folder into the music / audiobook / book / comic library by hand
  app.post('/api/files/import', async (req) => {
    requireAdmin(req);
    const b = body(req);
    const kinds: LibraryKind[] = ['music', 'audiobook', 'ebook', 'comic'];
    const kind = kinds.find((k) => k === b.kind);
    if (!kind) throw new HttpError('kind must be music, audiobook, ebook or comic', 400);
    const { real } = await resolveAllowed(str(b.path, 'path', { max: 4096 }));
    const res = await importToLibrary(real, kind, 'local');
    await notifyImported(contentOfKind(kind), [res.dest]);
    invalidatePlayerIndexes();
    return res;
  });
}
