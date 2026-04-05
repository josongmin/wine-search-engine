import type { FastifyInstance } from 'fastify';
import { InterpretRequestSchema } from '../schemas/search.schema.js';
import type { InterpretRouteDeps } from './route-deps.js';

/**
 * POST /v1/search/interpret — returns QueryPlanV1 only (no execution).
 */
export function registerInterpretRoute(
  app: FastifyInstance,
  deps: InterpretRouteDeps,
): void {
  app.post('/v1/search/interpret', async (request, reply) => {
    const parsed = InterpretRequestSchema.parse(request.body);

    const plan = await deps.interpretUseCase.execute({
      query: parsed.query,
      context: parsed.context,
      sessionContext: parsed.sessionContext,
      queryBudget: parsed.queryBudget,
    });

    void reply.status(200).send(plan);
  });
}
