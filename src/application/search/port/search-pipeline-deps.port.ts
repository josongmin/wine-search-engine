import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../../domain/query/service/planner.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { HybridRetrievalInput } from '../../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';
import type { RetrievalExecutionResult } from '../../../domain/retrieval/model/retrieval-execution-result.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../../domain/retrieval/model/retrieval-document.js';
import type { SourceRecordRef } from '../../../domain/entity/model/source-record-ref.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../../domain/retrieval/model/candidate-envelope.js';
import type { RetrievalDegradationSignal } from '../../../domain/retrieval/port/retrieval-degradation-observer.port.js';
import type { RetrievalDegradationCode } from '../../../domain/retrieval/port/retrieval-degradation-observer.port.js';
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
import type { ConstraintGraph } from '../../../domain/query/model/constraint-graph.js';
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
  execute?(input: HybridRetrievalInput): Promise<RetrievalExecutionResult>;
  generate(input: HybridRetrievalInput): Promise<RetrievalExecutionResult>;
  /**
   * Backward-compat shim for application/search callers that still pull
   * telemetry out-of-band. New code should consume execute()/generate()
   * return metadata directly.
   */
  getLastFusionTrace?(): RrfFusionTrace | undefined;
  /**
   * Backward-compat shim. Prefer `result.dropLog`.
   */
  getLastDropLog?(): readonly CandidateDropRecord[] | undefined;
  /**
   * Backward-compat shim. Prefer `result.degradation.signals`.
   */
  getLastDegradationSignals?(): readonly RetrievalDegradationSignal[];
  /**
   * Backward-compat shim. Prefer `result.degradation.codes`.
   */
  getLastDegradationCodes?(): readonly RetrievalDegradationCode[];
}

export interface EntityDocumentLookupPort {
  /**
   * @deprecated Test-only escape hatch. Production callers MUST use getDocuments().
   * Retained so minimal test stubs compile without providing a batch implementation.
   * Will be removed once all test helpers migrate to getDocuments-first stubs.
   */
  getDocument?(entityId: CanonicalEntityId): Promise<RetrievalDocument | null>;

  /**
   * Batch-fetch entity documents by ID. This is the **required production path**.
   *
   * Returned map contains only found documents; missing IDs are omitted.
   * Implementations MUST prefer backend-native batching over N single fetches.
   *
   * T-E4-01: Elevated to required -- entity route batch hydration depends on this.
   */
  getDocuments(entityIds: readonly CanonicalEntityId[]): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>>;

  /**
   * Optional narrow projection for exact drinkability metadata lookups.
   * Production index implementations should provide this so agent
   * check_drinking_window does not depend on full document hydration.
   */
  getDrinkingWindowDocuments?(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDrinkingWindowProjection>>;
}

export interface LookupResolverProjection {
  readonly entityId: CanonicalEntityId;
  readonly entityType: string;
  readonly canonicalLabel: string;
  readonly aliasesIdentitySafe: readonly string[];
  readonly identitySafeKeys: readonly string[];
  readonly producer?: string | undefined;
  readonly attributeHints?: Readonly<Record<string, unknown>> | undefined;
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;
}

export interface LookupResolverProjectionPort {
  getResolverProjections(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, LookupResolverProjection>>;
}

export interface BrowseRetrieverPort {
  /**
   * ADR-014 Phase 1b.3b: `graph` arg is optional and — when present —
   * overrides the flat `constraints.hard` bundle as the filter-token
   * source. Trivial-graph emission remains byte-identical.
   */
  browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
  ): Promise<readonly HybridCandidate[]>;

  browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
  ): Promise<readonly HybridCandidate[]>;
}

export interface CompareRetrieverPort {
  compareAgainstAnchor(
    anchorEntityId: CanonicalEntityId,
    constraints: ConstraintBundle,
    limit: number,
    graph?: ConstraintGraph  ,
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
  solve(queryPlan: QueryPlanV1, compiled: CompiledWineQuery): Promise<MixedQueryResult>;
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
