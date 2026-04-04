import type { FastifyInstance } from 'fastify';
import { InterpretRequestSchema } from '../schemas/search.schema.js';
import type { Container } from '../../../config/container.js';

/**
 * POST /v1/search/interpret — returns QueryPlanV1 only (no execution).
 */
export function registerInterpretRoute(
  app: FastifyInstance,
  container: Container,
): void {
  app.post('/v1/search/interpret', async (request, reply) => {
    const parsed = InterpretRequestSchema.parse(request.body);

    const plan = await container.interpretUseCase.execute({
      query: parsed.query,
      context: parsed.context,
      sessionContext: parsed.sessionContext,
      queryBudget: parsed.queryBudget,
    });

    void reply.status(200).send(plan);
  });
}
