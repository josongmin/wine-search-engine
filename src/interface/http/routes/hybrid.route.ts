import type { FastifyInstance } from 'fastify';
import { HybridRequestSchema } from '../schemas/search.schema.js';
import type { Container } from '../../../config/container.js';

/**
 * POST /v1/search/hybrid — force hybrid search route.
 */
export function registerHybridRoute(
  app: FastifyInstance,
  container: Container,
): void {
  app.post('/v1/search/hybrid', async (request, reply) => {
    const parsed = HybridRequestSchema.parse(request.body);

    const response = await container.hybridUseCase.execute(
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
