import type { FastifyInstance } from 'fastify';
import { HybridRequestSchema } from '../schemas/search.schema.js';
import type { HybridRouteDeps } from './route-deps.js';

/**
 * POST /v1/search/hybrid — force hybrid search route.
 */
export function registerHybridRoute(
  app: FastifyInstance,
  deps: HybridRouteDeps,
): void {
  app.post('/v1/search/hybrid', async (request, reply) => {
    const parsed = HybridRequestSchema.parse(request.body);

    const response = await deps.hybridUseCase.execute(
      {
        query: parsed.query,
        context: parsed.context,
        sessionContext: parsed.sessionContext,
        queryBudget: parsed.queryBudget,
        options: parsed.options,
      },
      request.requestId,
    );

    void reply.status(200).send(response);
  });
}
