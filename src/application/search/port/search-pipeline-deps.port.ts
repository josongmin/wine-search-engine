import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../../domain/query/service/planner.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { HybridRetrievalInput } from '../../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../../domain/ranking/model/ranking-input.js';
import type { RankedResult } from '../../../domain/ranking/model/ranked-result.js';
import type { DecisionInput } from '../../../domain/decision/model/decision-input.js';
import type { DecisionOutput } from '../../../domain/decision/model/decision-output.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { ResponseBuildParams } from '../../../domain/response/service/response-builder.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { MixedQueryResult } from '../../../domain/mixed/model/mixed-query-result.js';

export interface QueryPlannerPort {
  plan(query: string, context?: PlannerContext): Promise<QueryPlanV1>;
}

export interface EntityResolverPort {
  resolve(input: ResolverInput): Promise<EntityResolveResult>;
}

export interface CandidatePoolPort {
  generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]>;
}

export interface RankingPort {
  rank(input: RankingInput): Promise<readonly RankedResult[]>;
}

export interface DecisionEnginePort {
  decide(input: DecisionInput, snapshot: DecisionSnapshot): Promise<DecisionOutput>;
}

export interface ResponseBuilderPort {
  build(params: ResponseBuildParams): SearchResponseV1;
}

export interface MixedSolverPort {
  solve(queryPlan: QueryPlanV1): Promise<MixedQueryResult>;
}
