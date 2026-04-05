import type { FastifyInstance } from 'fastify';
import { SearchRequestSchema } from '../schemas/search.schema.js';
import { detectDecomposition, isValidDecomposition } from '../../../domain/query/service/decomposition-detector.js';
import type { SearchRouteDeps } from './route-deps.js';

/**
 * POST /v1/search — main search endpoint.
 * Handles both regular search and "A vs B" comparison queries.
 */
export function registerSearchRoute(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  app.post('/v1/search', async (request, reply) => {
    const parsed = SearchRequestSchema.parse(request.body);
    const startTime = Date.now();

    // Epic 14: Check for decomposable "A vs B" queries before routing to SearchUseCase
    const decompositionResult = detectDecomposition(parsed.query);
    if (isValidDecomposition(decompositionResult)) {
      const response = await deps.decomposedSearchUseCase.execute(
        decompositionResult.subQueries,
        decompositionResult.comparisonIntent,
        parsed.query,
        request.requestId,
        startTime,
      );
      void reply.status(200).send(response);
      return;
    }

    // Regular search
    const response = await deps.searchUseCase.execute(
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
