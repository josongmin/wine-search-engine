import type { FastifyInstance } from 'fastify';
import { ResolveRequestSchema } from '../schemas/search.schema.js';
import type { ResolveRouteDeps } from './route-deps.js';

/**
 * POST /v1/entity/resolve — entity resolution only.
 */
export function registerResolveRoute(
  app: FastifyInstance,
  deps: ResolveRouteDeps,
): void {
  app.post('/v1/entity/resolve', async (request, reply) => {
    const parsed = ResolveRequestSchema.parse(request.body);

    const result = await deps.resolveUseCase.execute({
      query: parsed.query,
      context: parsed.context,
      sessionContext: parsed.sessionContext,
    });

    void reply.status(200).send(result);
  });
}
