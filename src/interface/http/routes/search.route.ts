import type { FastifyInstance } from 'fastify';
import { SearchRequestSchema } from '../schemas/search.schema.js';
import type { Container } from '../../../config/container.js';

/**
 * POST /v1/search — main search endpoint.
 */
export function registerSearchRoute(
  app: FastifyInstance,
  container: Container,
): void {
  app.post('/v1/search', async (request, reply) => {
    const parsed = SearchRequestSchema.parse(request.body);

    const response = await container.searchUseCase.execute(
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
