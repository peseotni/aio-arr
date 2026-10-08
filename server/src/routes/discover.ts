import type { FastifyInstance } from 'fastify';
import { HttpError } from '../util/http.js';
import { dismiss, recommendations, refreshRecommendations, resolveItem } from '../domain/recommend.js';
import { attachPlayLinks } from '../domain/players.js';
import { body, optInt, params, str } from './util.js';

export async function discoverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/recommendations', async (req) => recommendations(req.user!));

  app.post('/api/recommendations/refresh', async (req) => {
    refreshRecommendations(req.user!);
    return recommendations(req.user!);
  });

  // "Not interested"
  app.post('/api/recommendations/dismiss', async (req) => {
    dismiss(req.user!.username, str(body(req).key, 'key', { max: 64 }));
    return { ok: true };
  });

  // A recommended title (TMDB id) -> the Radarr / Sonarr item needed to add it
  app.post('/api/library/:kind/resolve', async (req) => {
    const kind = params(req).kind;
    if (kind !== 'movie' && kind !== 'series') throw new HttpError('Only movies and shows can be resolved', 400);
    const b = body(req);
    const item = await resolveItem(kind, {
      tmdb: optInt(b.tmdb),
      tvdb: optInt(b.tvdb),
      title: typeof b.title === 'string' ? b.title.slice(0, 200) : undefined,
      year: optInt(b.year),
    });
    const [linked] = await attachPlayLinks([item]);
    return linked;
  });
}
