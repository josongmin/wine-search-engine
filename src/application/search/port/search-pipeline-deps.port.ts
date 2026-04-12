import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../../domain/query/service/planner.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { HybridRetrievalInput } from '../../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../../domain/retrieval/model/candidate-envelope.js';
import type { RankingInput } from '../../../domain/ranking/model/ranking-input.js';
import type { FunnelMetrics } from '../../../domain/ranking/model/ranking-stage.js';
import type { RankerRuntimeSignal } from '../../../domain/ranking/model/ranking-runtime-signal.js';
import type { RankingOutput } from '../../../domain/ranking/port/ranker.port.js';
import type { DecisionInput } from '../../../domain/decision/model/decision-input.js';
import type { DecisionOutput } from '../../../domain/decision/model/decision-output.js';
import type {
  CanonicalEntityId,
  ConstraintBundle,
  DecisionSnapshot,
} from '../../../domain/shared/types/index.js';
import type { ResponseBuildParams } from '../../../domain/response/service/response-builder.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { MixedQueryResult } from '../../../domain/mixed/model/mixed-query-result.js';
import type { CompiledWineQuery } from '../../../domain/query/model/compiled-wine-query.js';
/**
 * Combined plan + compiled result for implementations that can produce both in one call.
 * Avoids the V2-is-discarded problem in PlannerV1Adapter by exposing compiled alongside V1.
 *
 * NL constraint extraction provenance (when present) lives on `compiled.query.constraintExtraction`.
 */
export interface PlanWithCompiledResult {
  readonly v1: QueryPlanV1;
  readonly compiled: CompiledWineQuery;
}

export interface QueryPlannerPort {
  plan(query: string, context?: PlannerContext): Promise<QueryPlanV1>;

  /**
   * Optional extension: plan and compile in one call.
   * When available, consumers should prefer this over `plan()` to get the
   * ExecutionCompiler-produced CompiledWineQuery without re-deriving it downstream.
   * Falls back to `plan()` + local compilation when not implemented.
   */
  planWithCompiled?(query: string, context?: PlannerContext): Promise<PlanWithCompiledResult>;
}

export interface EntityResolverPort {
  resolve(input: ResolverInput): Promise<EntityResolveResult>;
}

export interface CandidatePoolPort {
  execute?(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]>;
  generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]>;
  /**
   * Returns the RRF fusion trace from the most recent execute() call.
   * Pattern mirrors getLastFunnelMetrics() on RankingPort.
   * Only implemented by CandidatePoolService — optional so existing stubs/adapters
   * do not need to be updated.
   */
  getLastFusionTrace?(): RrfFusionTrace | undefined;
  /**
   * Returns the hard-filter drop log from the most recent execute() call.
   * Pattern mirrors getLastFusionTrace().
   * Only implemented by CandidatePoolService — optional so existing stubs/adapters
   * do not need to be updated.
   */
  getLastDropLog?(): readonly CandidateDropRecord[] | undefined;
}

export interface EntityDocumentLookupPort {
  getDocument(entityId: CanonicalEntityId): Promise<RetrievalDocument | null>;
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
    anchorEntityId: CanonicalEntityId,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

export interface RankingPort {
  rank(input: RankingInput): Promise<RankingOutput>;
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
  solve(queryPlan: QueryPlanV1, compiled?: CompiledWineQuery): Promise<MixedQueryResult>;
}

/**
 * TA2-4: Application-layer blocker port — exposes the Blocker's high-recall
 * candidate retrieval to callers outside the resolver domain (entity route,
 * hybrid anchor resolver).
 *
 * Separate from the domain-level BlockingPort so the application layer does
 * not depend on the domain resolver internals. The broader recall option is
 * used by the corrective retry path (TA3) to expand the candidate set.
 */
export interface BlockingUseCasePort {
  /**
   * Returns candidate entity IDs that pass the blocking filter.
   *
   * @param query            Original user query string.
   * @param normalizedQuery  Lowercased, accent-stripped, whitespace-collapsed form.
   * @param options.broader  When true, use a higher limit / relaxed threshold for
   *                         corrective retry recall expansion (TA3).
   */
  block(
    query: string,
    normalizedQuery: string,
    options?: { readonly broader?: boolean },
  ): Promise<readonly CanonicalEntityId[]>;
}
