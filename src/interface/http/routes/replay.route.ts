import type { FastifyInstance } from 'fastify';
import { ReplayRequestSchema } from '../schemas/search.schema.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { ReplayRouteDeps } from './route-deps.js';

/**
 * POST /v1/search/replay — replay search with pinned decision snapshot.
 *
 * On SNAPSHOT_MISMATCH: the error handler returns 409 with the RFC-014 error contract.
 */
export function registerReplayRoute(
  app: FastifyInstance,
  deps: ReplayRouteDeps,
): void {
  app.post('/v1/search/replay', async (request, reply) => {
    const parsed = ReplayRequestSchema.parse(request.body);

    // Build a DecisionSnapshot compatible with exactOptionalPropertyTypes.
    const snapshot: DecisionSnapshot = {
      model_versions: parsed.decision_snapshot.model_versions,
      index_versions: parsed.decision_snapshot.index_versions,
      policy_rule_version: parsed.decision_snapshot.policy_rule_version,
      threshold_profile_id: parsed.decision_snapshot.threshold_profile_id,
      planner_version: parsed.decision_snapshot.planner_version,
      feature_flags: parsed.decision_snapshot.feature_flags,
      ...(parsed.decision_snapshot.nondeterminism_notes !== undefined
        ? { nondeterminism_notes: parsed.decision_snapshot.nondeterminism_notes }
        : {}),
    };

    const response = await deps.replayUseCase.execute(
      {
        query: parsed.query,
        decision_snapshot: snapshot,
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
