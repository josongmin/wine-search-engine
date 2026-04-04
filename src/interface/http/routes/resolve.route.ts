import type { FastifyInstance } from 'fastify';
import { ResolveRequestSchema } from '../schemas/search.schema.js';
import type { Container } from '../../../config/container.js';

/**
 * POST /v1/entity/resolve — entity resolution only.
 */
export function registerResolveRoute(
  app: FastifyInstance,
  container: Container,
): void {
  app.post('/v1/entity/resolve', async (request, reply) => {
    const parsed = ResolveRequestSchema.parse(request.body);

    const result = await container.resolveUseCase.execute({
      query: parsed.query,
      context: parsed.context,
      sessionContext: parsed.sessionContext,
    });

    void reply.status(200).send(result);
  });
}
