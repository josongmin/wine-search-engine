import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../../domain/query/service/planner.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { HybridRetrievalInput } from '../../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import type { RankingInput } from '../../../domain/ranking/model/ranking-input.js';
import type { RankedResult } from '../../../domain/ranking/model/ranked-result.js';
import type { FunnelMetrics } from '../../../domain/ranking/model/ranking-stage.js';
import type { RankerRuntimeSignal } from '../../../domain/ranking/model/ranking-runtime-signal.js';
import type { DecisionInput } from '../../../domain/decision/model/decision-input.js';
import type { DecisionOutput } from '../../../domain/decision/model/decision-output.js';
import type {
  ConstraintBundle,
  DecisionSnapshot,
  EntityId,
} from '../../../domain/shared/types/index.js';
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

export interface EntityDocumentLookupPort {
  getDocument(entityId: EntityId): Promise<RetrievalDocument | null>;
}

export interface BrowseRetrieverPort {
  browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;

  browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

export interface CompareRetrieverPort {
  compareAgainstAnchor(
    anchorEntityId: EntityId,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

export interface RankingPort {
  rank(input: RankingInput): Promise<readonly RankedResult[]>;
  /**
   * Returns the funnel metrics computed during the most recent rank() call.
   * Only implemented by stage-aware pipeline wrappers (e.g. RankingStagePipeline).
   * Returns undefined when funnel metrics are not tracked (plain Ranker).
   */
  getLastFunnelMetrics?(): FunnelMetrics | undefined;
  getLastRuntimeSignal?(): RankerRuntimeSignal | undefined;
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
