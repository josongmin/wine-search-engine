import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankingPort } from './port/search-pipeline-deps.port.js';
import { applyLtrRerankIfAvailable } from './search-usecase-ltr-rerank.js';
import { buildHybridRouteResolveResult } from './search-usecase-hybrid-route.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';

/**
 * Candidate pool output → rank → optional LTR → synthetic hybrid resolve result.
 */
export async function runHybridRankingPipeline(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  ranker: RankingPort,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): Promise<SearchRouteExecutionResult> {
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
  };

  let rankedResults = await ranker.rank(rankingInput);

  rankedResults = applyLtrRerankIfAvailable(
    rankedResults,
    plan.queryClass,
    ltrModels,
  );

  const resolveResult: EntityResolveResult = buildHybridRouteResolveResult(plan, rankedResults);

  return { resolveResult, rankedResults };
}
