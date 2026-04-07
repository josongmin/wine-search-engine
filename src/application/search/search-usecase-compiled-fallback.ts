import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1, QueryPlanV2 } from '../../domain/query/model/query-plan.js';
import { ExecutionCompiler } from '../../domain/query/service/execution-compiler.js';

const executionCompiler = new ExecutionCompiler();

function toQueryPlanV2(plan: QueryPlanV1): QueryPlanV2 {
  return {
    rawQuery: plan.rawQuery,
    normalizedQuery: plan.normalizedQuery,
    ...(plan.normalizedQueryViews !== undefined && { normalizedQueryViews: plan.normalizedQueryViews }),
    intent: plan.intent,
    ...(plan.secondaryIntents !== undefined && { secondaryIntents: plan.secondaryIntents }),
    suggestedRoute: plan.route,
    suggestedRetrievalMode: plan.retrievalMode,
    queryClass: plan.queryClass,
    anchors: plan.anchors,
    constraints: plan.constraints,
    expansions: plan.expansions,
    uncertainty: plan.uncertainty,
    plannerVersion: plan.plannerVersion,
    policyRuleVersion: plan.policyRuleVersion,
    thresholdProfileId: plan.thresholdProfileId,
    ...(plan.admission_context !== undefined && { admission_context: plan.admission_context }),
    ...(plan.sessionContext !== undefined && { sessionContext: plan.sessionContext }),
    ...(plan.queryBudget !== undefined && { queryBudget: plan.queryBudget }),
    ...(plan.targetEntityType !== undefined && { targetEntityType: plan.targetEntityType }),
    ...(plan.decompositionHint !== undefined && { decompositionHint: plan.decompositionHint }),
  };
}

/**
 * Compatibility-only fallback for callers that only received QueryPlanV1.
 * Centralizing this avoids multiple ad hoc V1 -> compiled bridges drifting.
 */
export function compileFromLegacyPlan(plan: QueryPlanV1): CompiledWineQuery {
  return executionCompiler.compile({ plan: toQueryPlanV2(plan) });
}
