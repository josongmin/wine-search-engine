import type { SearchIndexPort, DenseHit, SparseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';
import type {
  CandidateEnvelope,
  CandidateChannel,
  CandidateDropRecord,
  QueryViewMatch,
  RetrievalChannelFiringState,
  RetrievalChannelTrace,
  RrfFusionTrace,
} from '../model/candidate-envelope.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import type {
  RetrievalExecutionLane,
  RetrievalExecutionLanes,
  RetrievalExecutionResult,
  RetrievalLaneStatus,
} from '../model/retrieval-execution-result.js';
import { buildRetrievalExecutionResult } from '../model/retrieval-execution-result.js';
import { CandidateProvenanceV2Schema } from '../model/retrieval-contract-v2.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  preferCanonicalRetrievalChannelLabels,
  toCanonicalCandidateChannel,
  type RetrievalChannel,
} from '../model/retrieval-channel.js';

import { rrfContribution } from '../../shared/utils/rrf.js';
import { EMBEDDING_MODEL } from '../../shared/constants/embedding.js';
import { type FusionService, NEUTRAL_FUSION_WEIGHTS, type FusionWeights } from './fusion.js';
import { RetrievalProfileService } from './retrieval-profile.js';
import {
  getFusionConfig,
  mapDomainQueryClassToFusionQueryClass,
} from './per-class-fusion-config.js';
import { CascadeRouter, type RetrievalPhase } from './cascade-router.js';
import { ConstraintFilter } from './constraint-filter.js';
import {
  hardConstraintsToSparseFilterTokens,
  softConstraintsToOptionalFilterTokens,
} from './constraint-to-sparse-filter-tokens.js';
import {
  validateConstraintBundle,
  emitConstraintValidationTelemetry,
} from './constraint-validator.js';
import {
  extractSearchConstraints,
  krwToUsd,
} from '../../query/service/search-constraint-extractor.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { CandidateAssembler, type AssemblyPolicy } from './candidate-assembly.js';
import { applyProtectedRecallPolicy } from './protected-recall-policy.js';
import { accumulateEvidence } from './evidence-accumulator.js';
import { applyRelativeFilter } from './relative-filter-policy.js';
import { combineSemanticEmbeddings } from './semantic-embedding-combiner.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';
import type { CacheService } from '../../performance/index.js';
import type {
  RetrievalDegradationObserver,
  RetrievalDegradationCode,
  RetrievalDegradationSignal,
} from '../port/retrieval-degradation-observer.port.js';
import type { RetrievalExecutorV2Port } from '../port/retrieval-executor-v2.port.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { deriveQueryFamily } from '../../query/model/query-observability-vocab.js';
import { CircuitBreakerOpenError } from '../../shared/error/circuit-breaker-open-error.js';

/**
 * Wave 2 — classify a thrown error into the per-channel telemetry
 * firing-state bucket. The buckets are deliberately narrow so dashboards
 * can colour-code "expected dormant" vs "real infra failure" without
 * inspecting log strings.
 *
 * Heuristic-free: every branch is driven by a typed class / standard
 * DOM contract (CircuitBreakerOpenError, AbortError, plain Error).
 */
function classifyChannelError(err: unknown): 'circuit_breaker_open' | 'timeout' | 'error' {
  if (err instanceof CircuitBreakerOpenError) return 'circuit_breaker_open';
  // AbortError is the canonical Web-standard timeout marker — fetch + AbortSignal
  // both surface `name === 'AbortError'` when the per-channel deadline fires.
  if (err instanceof Error && err.name === 'AbortError') return 'timeout';
  return 'error';
}

function isSearchSubstrateUnavailable(searchIndex: SearchIndexPort): boolean {
  return searchIndex.getSearchAvailabilityState?.() === 'unavailable';
}

/** Default anchor confidence when plan omits explicit score (neutral). */
const HYBRID_ANCHOR_CONFIDENCE_DEFAULT = 0.5;

/**
 * Map the project's RFC-005 QueryClass vocabulary onto the fusion-config
 * QueryClass vocabulary. Per-class fusion config is a foundation module
 * that was standalone before this wire-up. getFusionConfig falls back to
 * DEFAULT_FUSION_CONFIG (k=60) for unknown classes, so the change is
 * behavior-preserving for queries outside the 5 mapped classes.
 *
 * Mapping rationale (domain alignment, not new logic):
 *   - short_entity, ambiguous_short_form, anchored_similarity → specific_wine
 *     (entity-anchored lookups where sparse/anchor channels should dominate)
 *   - pure_constraint, semantic_preference → browse
 *     (open-ended exploration where dense carries most of the signal)
 *   - comparison_query → compare
 *   - unknown → fallback (neutral k=60, equal weights)
 *
 * The fusion-config module does not define a 'pairing' mapping from any
 * RFC-005 class — pairing intent is not surfaced as its own QueryClass
 * today, so that config remains unused until an upstream pairing class
 * lands.
 *
 * TRACK-A A4: runtimeMode 'entity_anchor_first' overrides to 'entity_exact'
 * so the anchor-dominant fusion config is used instead of specific_wine.
 */
/** Max expansion terms fed into retrieval query views. */
const QUERY_EXPANSION_MAX_TERMS = 32;
/** Weight increment per repeated token occurrence in expansion stats. */
const QUERY_EXPANSION_TERM_WEIGHT_STEP = 0.25;

const PRICE_CONSTRAINT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'price',
  'price_usd',
]);

function hasStructuredPriceConstraint(constraints: readonly NormalizedConstraint[]): boolean {
  return constraints.some((constraint) =>
    PRICE_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)
    && constraint.soft_promotion_authority === 'allow'
  );
}

function buildRawQueryPriceConstraints(rawQuery: string): readonly NormalizedConstraint[] {
  if (rawQuery.length === 0) {
    return [];
  }
  const extracted = extractSearchConstraints(rawQuery);
  const constraints: NormalizedConstraint[] = [];
  if (extracted.minPriceKrw !== undefined && extracted.maxPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: 'range',
      value: {
        min: krwToUsd(extracted.minPriceKrw),
        max: krwToUsd(extracted.maxPriceKrw),
      },
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
    return constraints;
  }
  if (extracted.minPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: '>=',
      value: krwToUsd(extracted.minPriceKrw),
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
  }
  if (extracted.maxPriceKrw !== undefined) {
    constraints.push({
      attribute: 'price_usd',
      operator: '<=',
      value: krwToUsd(extracted.maxPriceKrw),
      source_phrase: 'raw_query_price_extractor',
      confidence: 1,
      mapping_version: 'raw-query-price-extractor-v1',
    });
  }
  return constraints;
}
// W0-2: Removed LEARNED_SPARSE_CHANNEL_ENABLED compile-time flag.
// The single source of truth is now `killSwitchLearning` (constructor arg) wired
// from `config.killSwitch.learning`. This enables SPLADE / learned_sparse
// experiments by toggling a runtime flag instead of recompiling.

/**
 * Orchestrates the full hybrid retrieval pipeline (RFC-012).
 *
 * Pipeline steps:
 * 1. Execute sparse search with lexical queries + hard constraint filters.
 * 2. Embed semantic queries and execute dense search (with embedding cache).
 * 3. If an anchor profile is present, embed anchor and run neighbourhood search.
 * 4. Fuse all passes via RRF.
 * 5. Apply hard constraint filter on fused candidates.
 * 6. Return top-K candidates.
 *
 * Dependencies injected for testability and loose coupling (SOLID - D principle).
 */

/**
 * Runtime retrieval mode resolved by `resolveRuntimeRetrievalMode`.
 *
 * It is the compiled `ExecutionRetrievalMode` PLUS the two router-internal
 * modes that never appear on the engine-execution contract but are produced
 * here:
 *  - `'relative'`            → compare_candidates with an explicit anchor entity.
 *  - `'entity_anchor_first'` → TRACK-A A4 anchor-dominant dual path.
 *
 * Typed as a closed union (not bare `string`) so a typo in a future mode
 * literal is caught at compile time. Downstream consumers (`getProfile`,
 * `resolveVespaRankProfile`, `mapDomainQueryClassToFusionQueryClass`) accept
 * `string`, so the narrower type is assignable everywhere.
 */
export type RuntimeRetrievalMode =
  | ExecutionRetrievalMode
  | 'relative'
  | 'entity_anchor_first';

/**
 * Retrieval modes that handle their own routing and must not be overridden by
 * the TRACK-A A4 entity_anchor_first path. Only undefined / entity_lookup /
 * entity_resolution / legacy mode strings are safe to override.
 */
const ANCHOR_FIRST_BLOCKED_MODES: ReadonlySet<string> = new Set([
  'producer_browse', 'region_browse', 'compare_candidates',
  'recommendation', 'similar_items', 'attribute_search',
  'constraint_filter', 'no_match_detection',
]);

export class CandidatePoolService implements RetrievalExecutorV2Port {
  private readonly profileService: RetrievalProfileService;
  private readonly cascadeRouter: CascadeRouter;
  private readonly constraintFilter: ConstraintFilter;
  private readonly candidateAssembler: CandidateAssembler;
  /** Authoritative request-scoped retrieval result; replaces mutable getLast* state. */
  private _lastExecutionResult: RetrievalExecutionResult | undefined = undefined;

  constructor(
    private readonly searchIndex: SearchIndexPort,
    private readonly embeddingService: EmbeddingServicePort,
    private readonly fusionService: FusionService,
    private readonly cacheService?: CacheService | undefined,
    private readonly embeddingModelId: string = EMBEDDING_MODEL,
    private readonly killSwitchLearning: boolean = false,
    private readonly degradationObserver?: RetrievalDegradationObserver | undefined,
    /**
     * T02-2: Dense kill switch pre-flight guard.
     * When true, the dense retrieval channel (and anchor-similarity, which
     * also requires an embedding) is SKIPPED entirely — no embedding fetch,
     * no denseSearch call. This prevents wasted embedding API spend/latency
     * when dense is administratively disabled, and is distinct from a
     * per-request runtime degradation (which still attempts the call and
     * falls back).
     */
    private readonly killSwitchDenseRetrieval: boolean = false,
  ) {
    this.profileService = new RetrievalProfileService();
    this.cascadeRouter = new CascadeRouter();
    this.constraintFilter = new ConstraintFilter();
    this.candidateAssembler = new CandidateAssembler();
  }

  /**
   * Generate a ranked candidate pool from the hybrid retrieval pipeline.
   *
   * @param input - The retrieval input derived from the query plan.
   * @returns Fused, filtered, and ranked candidates.
   */
  async execute(input: HybridRetrievalInput): Promise<RetrievalExecutionResult> {
    this.degradationObserver?.onRetrievalStarted();
    this._lastExecutionResult = undefined;
    const degradationSignals: RetrievalDegradationSignal[] = [];
    const degradationCodes: RetrievalDegradationCode[] = [];
    const queryFamily = deriveQueryFamily(input.queryPlan);
    const retrievalMode = this.resolveRuntimeRetrievalMode(input);
    // Specialized routing (producer_browse / region_browse / compare_candidates)
    // is decided upstream in search-usecase-hybrid-candidates.ts from
    // compiled.execution.effectiveRetrievalMode, so this path only needs the
    // generic retrieval profile.
    const profile = this.profileService.getProfile(
      input.queryPlan.queryClass,
      input.route,
      retrievalMode,
      queryFamily,
    );

    const anchorConfidence = input.anchorProfile?.anchorConfidence ?? 0;
    const aliasMatchStrength = this.estimateAliasStrength(input);
    const dispatchDecision = this.cascadeRouter.getDispatchDecision(
      input.queryPlan.queryClass,
      anchorConfidence,
      aliasMatchStrength,
      input.hardConstraints.length + input.softConstraints.length,
    );

    const activeChannels = this.resolveActiveChannels(profile.channelMix, dispatchDecision, input, retrievalMode);
    const allPhases: RetrievalPhase[] = [
      'sparse',
      RETRIEVAL_CHANNEL_LEARNED_SPARSE,
      'dense',
      'anchor_neighborhood',
      'relative',
    ];
    const skippedPhases = allPhases.filter((phase) => !this.shouldExecutePhase(phase, activeChannels));

    // Vespa sparse filter tokens (aligned with browse/compare + buildSparseFilters).
    //
    // P1.A — soft→hard confidence-gated promotion. High-confidence preference
    // signals (rule-based / entity-resolver mapping versions, confidence ≥ 0.8)
    // promote into the same registry-mapped sparse filter tokens hard constraints
    // use. This closes the gap where "평점 좋은 와인" / "지금 마실 수 있는" parsed as
    // soft and NEVER tightened Vespa retrieval — leaving the 7K-doc corpus
    // under-filtered and the candidate pool low-precision.
    // Compile-time constraint validation BEFORE YQL emission. Surfaces
    // (a) unrecognized attributes — planner emitted something the YQL
    // layer cannot represent (silent drop pre-fix), and (b) intentionally
    // strategy-governed soft intents (for example drinking_window post-search
    // verification, or candidate-shaping-only price_band / style paths)
    // that flow into softBoosts but cannot promote to filters. Telemetry
    // fires once per (tier, attribute, reason) per process via the module
    // cache in constraint-validator.ts — hot-path safe.
    const supplementalRawPriceConstraints = !hasStructuredPriceConstraint([
      ...input.hardConstraints,
      ...input.softConstraints,
    ])
      ? buildRawQueryPriceConstraints(input.queryPlan.rawQuery)
      : [];
    const effectiveHardConstraints = [
      ...input.hardConstraints,
      ...supplementalRawPriceConstraints,
    ];
    const validationReport = validateConstraintBundle({
      hard: effectiveHardConstraints,
      soft: input.softConstraints,
    });
    emitConstraintValidationTelemetry(validationReport, {
      query_class: input.queryPlan.queryClass,
      request_id: input.requestContext?.requestId,
    });
    const hardFilterTokens = hardConstraintsToSparseFilterTokens(effectiveHardConstraints);
    const promotedSoftFilterTokens = softConstraintsToOptionalFilterTokens(input.softConstraints);
    const filters = [
      ...hardFilterTokens,
      ...promotedSoftFilterTokens,
    ];

    // S4.1 — soft→hard promotion observability. Without this, bench logs
    // cannot tell whether P1's confidence-gated promotion actually fired or
    // whether the promoted soft filters reached the Vespa YQL filter set.
    // We log BEFORE any downstream sparse/dense dispatch so the promotion
    // count stays attributable to the soft-constraint path only.
    // Emitted as an `event`-tagged structured log to mirror the existing
    // `retrieval.difficulty_parallel` / search_execution observability shape.
    bootstrapLogger.debug(
      {
        event: 'retrieval.soft_promotion',
        query_class: input.queryPlan.queryClass,
        promotedSoftFilterCount: promotedSoftFilterTokens.length,
        promotedSoftFilterTokens,
        hardFilterTokenCount: hardFilterTokens.length,
        softConstraintCount: input.softConstraints.length,
        yqlFilterTokenCount: filters.length,
        ...(input.requestContext?.requestId !== undefined
          ? { request_id: input.requestContext.requestId }
          : {}),
      },
      'soft→hard constraint promotion',
    );

    const anchorDocument = await this.loadAnchorDocumentIfNeeded(input, activeChannels, retrievalMode);
    const anchorProfile = this.resolveAnchorProfile(input, anchorDocument);

    // Select Vespa rank profile based on retrieval mode.
    // Browse modes use prestige_hybrid to boost critic score + producer prestige
    // at the Vespa native-ranking stage, reducing post-retrieval re-ranking load.
    const vespaRankProfile = resolveVespaRankProfile(retrievalMode);

    // Steps 1–3: Run sparse, learned-sparse, dense (with embedding), and
    // anchor-neighbourhood channels CONCURRENTLY.
    //
    // The four channels are data-independent once `filters`, `anchorProfile`,
    // and `activeChannels` are resolved above. Embedding fetches remain
    // sequential WITHIN their own channel task (dense: semantic embed →
    // denseSearch; anchor: anchor embed → denseSearch) but the entire dense
    // path runs in parallel with sparse/learned-sparse/anchor.
    //
    // Each task returns a structured result with its hits, degradation flag,
    // and (optional) degradation report so that the caller can merge them
    // without races on shared mutable state.

    const filtersOrUndefined = filters.length > 0 ? filters : undefined;
    // W2-BUG-05: propagate request ID to downstream Vespa queries so
    // distributed traces can be correlated across service boundaries.
    const requestId = input.requestContext?.requestId;

    type DegradationReport = {
      readonly component: RetrievalChannel | 'embedding_combiner';
      readonly severity: 'error' | 'warning';
      readonly reason: string;
      readonly fallbackApplied: string;
      /**
       * Wave 2 — error classification for per-channel telemetry firing-state.
       *  - 'circuit_breaker_open' → caller observed a CircuitBreakerOpenError.
       *  - 'timeout'              → caller observed an AbortError / timeout signal.
       *  - 'error'                → any other infra failure.
       *  - undefined              → legacy callsite that did not classify; treated as 'error'.
       */
      readonly errorKind?: 'circuit_breaker_open' | 'timeout' | 'error' | undefined;
    };

    type LaneResult<THit> = {
      readonly hits: readonly THit[];
      readonly status: RetrievalLaneStatus;
      readonly degraded: boolean;
      readonly degradation?: DegradationReport;
    };
    type SparseResult = LaneResult<SparseHit>;
    type DenseLikeResult = LaneResult<DenseHit>;
    type AnchorResult = LaneResult<DenseHit>;
    const sparseTopN = resolveExplorationTopN(
      profile.sparseTopN,
      input.executionBudgetMaxCandidates,
    );
    const denseTopN = resolveExplorationTopN(
      profile.denseTopN,
      input.executionBudgetMaxCandidates,
    );

    const sparseTask = async (): Promise<SparseResult> => {
      if (!activeChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25)) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      if (isSearchSubstrateUnavailable(this.searchIndex)) {
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_SPARSE_BM25,
            severity: 'error',
            reason: 'search substrate unavailable (circuit breaker open)',
            fallbackApplied: 'dense-only retrieval',
            errorKind: 'circuit_breaker_open',
          },
        };
      }
      // TA4: Merge entity hypothesis terms from fuzzy match into lexical queries.
      // These are fuzzy-entity surface forms forwarded from the planner's anchor-miss
      // path — they provide an entity-first BM25 seed separate from query expansion.
      // Deduplicate to avoid double-scoring the same term already in lexicalQueries.
      const baseQueries = input.lexicalQueries;
      const hypothesisTerms = input.entityHypothesisTerms ?? [];
      const effectiveLexicalQueries =
        hypothesisTerms.length > 0
          ? [...new Set([...baseQueries, ...hypothesisTerms])]
          : baseQueries;
      // RCA5-08: empty lexicalQueries → Vespa receives an empty query array
      // which produces invalid YQL and a Vespa 500 error. Guard here in addition
      // to the vespa-search-index.ts guard — defence-in-depth, and allows the
      // candidate-pool to be tested without a Vespa dependency.
      if (effectiveLexicalQueries.length === 0) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      try {
        const hits = await this.searchIndex.sparseSearch(
          effectiveLexicalQueries,
          filtersOrUndefined,
          sparseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits, status: hits.length > 0 ? 'ok' : 'empty', degraded: false };
      } catch (sparseErr) {
        bootstrapLogger.warn(
          {
            err: sparseErr,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Sparse search failed — degrading to dense-only retrieval',
        );
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_SPARSE_BM25,
            severity: 'error',
            reason: sparseErr instanceof Error ? sparseErr.message : 'sparse search failed',
            fallbackApplied: 'dense-only retrieval',
            errorKind: classifyChannelError(sparseErr),
          },
        };
      }
    };

    const learnedSparseTask = async (): Promise<DenseLikeResult> => {
      // W0-2: single gate via killSwitchLearning. Active channel resolution
      // already excludes learned_sparse when killSwitchLearning is true (see
      // resolveActiveChannels), so this guard is the canonical channel check.
      if (!activeChannels.has(RETRIEVAL_CHANNEL_LEARNED_SPARSE)) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      if (isSearchSubstrateUnavailable(this.searchIndex)) {
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
            severity: 'error',
            reason: 'search substrate unavailable (circuit breaker open)',
            fallbackApplied: 'continue without learned sparse',
            errorKind: 'circuit_breaker_open',
          },
        };
      }
      try {
        const hits = await this.searchIndex.searchLearnedSparse(
          buildLearnedSparseQueryWeights(input),
          filtersOrUndefined,
          sparseTopN,
          requestId,
        );
        return { hits, status: hits.length > 0 ? 'ok' : 'empty', degraded: false };
      } catch (learnedErr) {
        bootstrapLogger.warn(
          {
            err: learnedErr,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Learned sparse search failed — continuing without learned sparse',
        );
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
            severity: 'error',
            reason: learnedErr instanceof Error ? learnedErr.message : 'learned sparse search failed',
            fallbackApplied: 'continue without learned sparse',
            errorKind: classifyChannelError(learnedErr),
          },
        };
      }
    };

    const denseTask = async (): Promise<DenseLikeResult> => {
      const embeddingQueries = input.semanticEmbeddingQueries ?? input.semanticQueries;
      // T02-2: Dense kill switch pre-flight guard. Skip embedding fetch +
      // denseSearch entirely so we don't pay embedding API cost when dense
      // is administratively disabled. Distinct from per-request degradation.
      if (this.killSwitchDenseRetrieval) {
        return {
          hits: [],
          status: 'disabled',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
            severity: 'warning',
            reason: 'dense kill switch enabled',
            fallbackApplied: 'sparse-only retrieval',
          },
        };
      }
      if (!(activeChannels.has(RETRIEVAL_CHANNEL_DENSE_SEMANTIC) && embeddingQueries.length > 0)) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      if (isSearchSubstrateUnavailable(this.searchIndex)) {
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
            severity: 'error',
            reason: 'search substrate unavailable (circuit breaker open)',
            fallbackApplied: 'sparse-only retrieval',
            errorKind: 'circuit_breaker_open',
          },
        };
      }
      try {
        const embeddings = this.cacheService
          ? await this.cacheService.getOrEmbedBatch(
              embeddingQueries,
              this.embeddingModelId,
              this.embeddingService,
            )
          : await this.embeddingService.embedBatch(embeddingQueries);

        const validEmbeddings = embeddings.filter(
          (embedding): embedding is readonly number[] => embedding !== null,
        );
        const primaryEmbedding = combineSemanticEmbeddings(validEmbeddings);
        // Reject both undefined AND empty embeddings — an empty Float32Array
        // is truthy but produces nonsense ANN results / Vespa errors downstream.
        if (!primaryEmbedding || primaryEmbedding.length === 0) {
          globalSilentSkipCounter.increment('embedding_empty_vector', {
            queryClass: input.queryPlan.queryClass,
            semanticQueryCount: embeddingQueries.length,
          });
          bootstrapLogger.error(
            {
              queryClass: input.queryPlan.queryClass,
              semanticQueryCount: embeddingQueries.length,
              embeddingModelId: this.embeddingModelId,
              reason: !primaryEmbedding ? 'embedding_undefined' : 'embedding_empty',
            },
            '[CandidatePool] Dense retrieval expected a non-empty embedding',
          );
          return {
            hits: [],
            status: 'infra_failure',
            degraded: true,
            degradation: {
              component: 'embedding_combiner',
              severity: 'error',
              reason: !primaryEmbedding ? 'embedding_undefined' : 'embedding_empty',
              fallbackApplied: 'skip dense retrieval',
            },
          };
        }
        const hits = await this.searchIndex.denseSearch(
          primaryEmbedding,
          filtersOrUndefined,
          denseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits, status: hits.length > 0 ? 'ok' : 'empty', degraded: false };
      } catch (denseErr) {
        bootstrapLogger.warn(
          {
            err: denseErr,
            queryClass: input.queryPlan.queryClass,
            embeddingModelId: this.embeddingModelId,
          },
          '[CandidatePool] Dense retrieval failed — degrading to sparse-only retrieval',
        );
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
            severity: 'error',
            reason: denseErr instanceof Error ? denseErr.message : 'dense retrieval failed',
            fallbackApplied: 'sparse-only retrieval',
            errorKind: classifyChannelError(denseErr),
          },
        };
      }
    };

    const anchorTask = async (): Promise<AnchorResult> => {
      // T02-2: anchor similarity also uses an embedding (anchor.semanticSummary
      // → embed → denseSearch), so it's gated by the same kill switch.
      if (this.killSwitchDenseRetrieval) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      if (!(activeChannels.has(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY) && anchorProfile !== undefined)) {
        return { hits: [], status: 'disabled', degraded: false };
      }
      if (isSearchSubstrateUnavailable(this.searchIndex)) {
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
            severity: 'warning',
            reason: 'search substrate unavailable (circuit breaker open)',
            fallbackApplied: 'no-anchor retrieval',
            errorKind: 'circuit_breaker_open',
          },
        };
      }
      try {
        // BUG-04: use cacheService.getOrEmbedBatch() when available so the
        // anchor embedding hits the embedding cache instead of always calling
        // the embedding API directly. Falls back to embeddingService.embed()
        // when no cacheService is wired (e.g. in unit tests or stripped envs).
        let resolvedAnchorEmbedding: readonly number[];
        if (anchorProfile.embedding !== undefined) {
          resolvedAnchorEmbedding = anchorProfile.embedding;
        } else if (this.cacheService !== undefined) {
          const embeddings = await this.cacheService.getOrEmbedBatch(
            [anchorProfile.semanticSummary],
            this.embeddingModelId,
            this.embeddingService,
          );
          const first = embeddings[0];
          if (first == null || first.length === 0) {
            throw new Error('Anchor embedding returned empty vector from cache service');
          }
          resolvedAnchorEmbedding = first;
        } else {
          resolvedAnchorEmbedding = await this.embeddingService.embed(anchorProfile.semanticSummary);
        }
        const anchorEmbedding = resolvedAnchorEmbedding;

        const hits = await this.searchIndex.denseSearch(
          anchorEmbedding,
          filtersOrUndefined,
          denseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits, status: hits.length > 0 ? 'ok' : 'empty', degraded: false };
      } catch (anchorErr) {
        bootstrapLogger.warn(
          {
            err: anchorErr,
            anchorConfidence,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Anchor embedding failed — degrading to no-anchor retrieval',
        );
        return {
          hits: [],
          status: 'infra_failure',
          degraded: true,
          degradation: {
            component: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
            severity: 'warning',
            reason: anchorErr instanceof Error ? anchorErr.message : 'anchor embedding failed',
            fallbackApplied: 'no-anchor retrieval',
            errorKind: classifyChannelError(anchorErr),
          },
        };
      }
    };

    // Per-stage latency tracking. The stage timer is request-scoped and
    // optional — callers without an HTTP request context (eval runs, unit
    // tests, batch jobs) simply skip the increments. Stage names mirror
    // the channel labels so the snapshot matches what `pipeline_debug`
    // emits in `PipelineDebugStep`.
    const stageTimer = input.requestContext?.stageTimer;
    stageTimer?.start('retrieval.parallel_fanout');
    const wrap = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      stageTimer?.start(name);
      try {
        return await task();
      } finally {
        stageTimer?.end(name);
      }
    };

    // Promise.allSettled instead of Promise.all so a single uncaught throw
    // (e.g. an internal Promise rejection inside embed/cache code that
    // escapes the per-task try-catch) cannot reject the whole retrieval
    // pipeline. Each task already converts known failures into a graceful
    // `degraded` result; this is a defense-in-depth fallback for the
    // unknown-unknowns. Rejected entries are converted into a synthetic
    // degradation report with severity:'error' and an empty hit set so
    // downstream fusion sees the same shape as a normal degraded task.
    const settled = await Promise.allSettled([
      wrap('retrieval.sparse_bm25', sparseTask),
      wrap('retrieval.learned_sparse', learnedSparseTask),
      wrap('retrieval.dense_semantic', denseTask),
      wrap('retrieval.anchor_similarity', anchorTask),
    ]);
    stageTimer?.end('retrieval.parallel_fanout');

    const sparseFallback: SparseResult = {
      hits: [],
      status: 'infra_failure',
      degraded: true,
      degradation: {
        component: RETRIEVAL_CHANNEL_SPARSE_BM25,
        severity: 'error',
        reason: 'sparse task threw uncaught error',
        fallbackApplied: 'empty sparse hits',
      },
    };
    const learnedSparseFallback: DenseLikeResult = {
      hits: [],
      status: 'infra_failure',
      degraded: true,
      degradation: {
        component: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
        severity: 'error',
        reason: 'learned sparse task threw uncaught error',
        fallbackApplied: 'continue without learned sparse',
      },
    };
    const denseFallback: DenseLikeResult = {
      hits: [],
      status: 'infra_failure',
      degraded: true,
      degradation: {
        component: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
        severity: 'error',
        reason: 'dense task threw uncaught error',
        fallbackApplied: 'sparse-only retrieval',
      },
    };
    const anchorFallback: AnchorResult = {
      hits: [],
      status: 'infra_failure',
      degraded: true,
      degradation: {
        component: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
        severity: 'warning',
        reason: 'anchor task threw uncaught error',
        fallbackApplied: 'no-anchor retrieval',
      },
    };

    const settle = <T>(
      result: PromiseSettledResult<T>,
      fallback: T,
      label: string,
    ): T => {
      if (result.status === 'fulfilled') return result.value;
      bootstrapLogger.error(
        {
          err: result.reason,
          channel: label,
          queryClass: input.queryPlan.queryClass,
        },
        '[CandidatePool] Channel task rejected outside its try-catch — applying defensive fallback',
      );
      return fallback;
    };

    const sparseResult = settle(settled[0], sparseFallback, 'sparse');
    const learnedSparseResult = settle(settled[1], learnedSparseFallback, RETRIEVAL_CHANNEL_LEARNED_SPARSE);
    const denseResult = settle(settled[2], denseFallback, 'dense');
    const anchorResult = settle(settled[3], anchorFallback, 'anchor');

    // Report degradations on the single shared observer after the parallel
    // fan-in. Observer callbacks are invoked in a deterministic order
    // (sparse → learned-sparse → dense → anchor) to preserve log/trace
    // ordering that downstream assertions may rely on.
    for (const report of [
      sparseResult.degradation,
      learnedSparseResult.degradation,
      denseResult.degradation,
      anchorResult.degradation,
    ]) {
      if (report !== undefined) {
        this.degradationObserver?.onDegradation(report);
        degradationSignals.push(report);
      }
    }

    const sparseHits = sparseResult.hits;
    const sparseDegraded = sparseResult.degraded;
    const learnedSparseHits = learnedSparseResult.hits;
    const denseHits = denseResult.hits;
    const denseDegraded = denseResult.degraded;
    const anchorHits = anchorResult.hits;
    let relativeLane: RetrievalExecutionLane<never> = {
      status: 'disabled',
      hits: [],
      degraded: false,
    };

    // Step 4: Fuse via RRF
    stageTimer?.start('retrieval.rrf_fusion');
    // Per-class fusion config is a foundation module (Epic-16 / T16-2) that
    // was standalone before this wire-up. getFusionConfig falls back to
    // DEFAULT_FUSION_CONFIG (k=60) for unknown classes, so the change is
    // behavior-preserving for queries outside the 5 mapped classes. The
    // profile.fusionK still acts as the ultimate fallback when the mapped
    // class resolves to 'fallback' AND profile opts to a non-default k.
    const fusionQueryClass = mapDomainQueryClassToFusionQueryClass(input.queryPlan.queryClass, retrievalMode);
    const fusionConfig = getFusionConfig(fusionQueryClass);
    const effectiveFusionK = fusionConfig.rrfK;
    // P1.C — thread per-class lane weights into FusionService.fuse(). Prior
    // to this wire-up, per-class sparseWeight/denseWeight/anchorWeight were
    // documentation-only — fuse() consumed only `k`.
    //
    // Fallback class explicitly uses NEUTRAL_FUSION_WEIGHTS to preserve
    // byte-identical behavior for the long tail of unmapped query classes
    // (every unknown class still routes through the fallback registry entry).
    // Mapped classes (specific_wine / entity_exact / browse / compare / pairing)
    // use their calibrated registry values, which is the change that closes
    // the "RRF weights are dead code" gap.
    const fusionWeights: FusionWeights =
      fusionQueryClass === 'fallback'
        ? NEUTRAL_FUSION_WEIGHTS
        : {
            sparseWeight: fusionConfig.sparseWeight,
            denseWeight: fusionConfig.denseWeight,
            anchorWeight: fusionConfig.anchorWeight,
            learnedSparseWeight: fusionConfig.learnedSparseWeight,
          };
    let candidates = this.fusionService.fuse(
      sparseHits,
      denseHits,
      anchorHits,
      effectiveFusionK,
      learnedSparseHits,
      fusionWeights,
    );
    stageTimer?.end('retrieval.rrf_fusion');
    const countAfterFusion = candidates.length;

    // Enrich traces with pipeline context.
    // Perf: the query-level trace fields (lexical/semantic queries, filters,
    // skipped phases, profile name) are IDENTICAL across every candidate.
    // Build them once outside the loop and share the references — the
    // previous implementation spread the full HybridCandidate (40+ fields)
    // and allocated fresh defensive copies of lexicalQueries/semanticQueries
    // per candidate, turning a 200-candidate pool into 10K+ unnecessary
    // allocations (Rules: avoid per-candidate object spread, hoist
    // deterministic constants).
    const effectiveSkippedPhases: readonly RetrievalPhase[] = [
      ...skippedPhases,
      ...(sparseDegraded ? ['sparse' as RetrievalPhase] : []),
      ...(denseDegraded ? ['dense' as RetrievalPhase] : []),
    ];
    const sharedLexicalQueries: readonly string[] = [...input.lexicalQueries];
    const sharedSemanticQueries: readonly string[] = [
      ...(input.semanticEmbeddingQueries ?? input.semanticQueries),
    ];
    candidates = candidates.map((c) => ({
      ...c,
      retrievalTrace: {
        ...c.retrievalTrace,
        retrievalProfile: profile.name,
        lexicalQueriesUsed: sharedLexicalQueries,
        semanticQueriesUsed: sharedSemanticQueries,
        filtersApplied: filters,
        skippedPhases: effectiveSkippedPhases,
      } satisfies RetrievalTrace,
    }));

    if (activeChannels.has(RETRIEVAL_CHANNEL_RELATIVE_FILTER) && input.anchorEntityId !== undefined) {
      const preFilterCount = candidates.length;
      candidates = applyRelativeFilter(candidates, {
        anchorEntityId: input.anchorEntityId,
        constraints: filters,
        ...(anchorDocument !== undefined ? { anchorDocument } : {}),
      });
      // Detect anchor-not-found fallback: if the anchor entity is absent from
      // both the candidate pool and the loaded anchorDocument, applyRelativeFilter
      // returns the unfiltered list — same length, no filtering applied.
      if (
        anchorDocument === undefined &&
        !candidates.some((c) => c.entityId === input.anchorEntityId) &&
        candidates.length === preFilterCount
      ) {
        const relativeFilterSignal: RetrievalDegradationSignal = {
          component: RETRIEVAL_CHANNEL_RELATIVE_FILTER,
          severity: 'error',
          reason: 'anchor entity not found in candidate pool or document store',
          fallbackApplied: 'return no candidates',
        };
        this.degradationObserver?.onDegradation(relativeFilterSignal);
        degradationSignals.push(relativeFilterSignal);
        candidates = [];
        relativeLane = {
          status: 'infra_failure',
          hits: [],
          degraded: true,
          error: relativeFilterSignal.reason,
          inputCount: preFilterCount,
          outputCount: 0,
        };
      } else {
        relativeLane = {
          status: candidates.length > 0 ? 'ok' : 'empty',
          hits: [],
          degraded: false,
          inputCount: preFilterCount,
          outputCount: candidates.length,
        };
      }
    }

    candidates = annotateCandidateConstraintEvidenceBatch(
      candidates,
      {
        hard: input.hardConstraints,
        soft: input.softConstraints,
        inferred: input.queryPlan.constraints.inferred,
      },
      // ADR-014 Phase 1b.3b: thread the compiled query's constraint graph
      // so the annotator emits `matchedAtomRefs` / `unmetAtomRefs` on each
      // candidate. Absent graph → flat annotator output, byte-identical to
      // pre-PR5.
      input.constraintGraph,
    );

    // Step 5: Apply hard constraint filter (with drop log for E4 audit).
    stageTimer?.start('retrieval.hard_filter');
    const { filtered: hardFiltered, drops: hardFilterDrops } =
      this.constraintFilter.applyHardFiltersWithDropLog(candidates, input.hardConstraints);
    candidates = [...hardFiltered];
    const countAfterHardFilter = candidates.length;
    stageTimer?.end('retrieval.hard_filter');

    // Step 6: Structured assembly + protected recall.
    stageTimer?.start('retrieval.candidate_assembly');
    const envelopes = candidates.map((candidate) =>
      hybridCandidateToEnvelope(candidate, effectiveFusionK));
    const protectedCandidates = applyProtectedRecallPolicy(envelopes);
    const accumulated = accumulateEvidence(protectedCandidates);
    const assembled = this.candidateAssembler.assemble(
      accumulated.map((entry) => entry.mergedEnvelope),
      buildAssemblyPolicy(
        resolveExplorationTopN(
          profile.finalTopK,
          input.executionBudgetMaxCandidates,
        ),
      ),
    );

    stageTimer?.end('retrieval.candidate_assembly');

    // Critic-facing structured degradation codes are derived from
    // production-observable pool states rather than log strings:
    //   - sparse_pool: sparse retrieval returned no hits even though the
    //     sparse channel was active and completed successfully.
    //   - no_matches: the final assembled candidate pool is empty.
    if (activeChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25) && !sparseResult.degraded && sparseHits.length === 0) {
      degradationCodes.push('sparse_pool');
    }
    if (assembled.candidates.length === 0) {
      degradationCodes.push('no_matches');
    }

    // Wave 2 — build per-channel telemetry rows. Operators read these
    // to see, for a single request, which channels actually fired vs.
    // sat dormant vs. failed, and how much each contributed to the
    // final fused ordering.
    //
    // `fusionContribution` is summed from the assembled candidates'
    // provenance rows (which already carry per-channel
    // `rrfContribution`s built by `hybridCandidateToEnvelope`). That
    // means the number measures contribution to the OUTPUT ordering,
    // not raw fanout.
    const fusionContributionByChannel = new Map<CandidateChannel, number>();
    for (const envelope of assembled.candidates) {
      for (const score of envelope.provenance.channelScores) {
        const prior = fusionContributionByChannel.get(score.channel) ?? 0;
        fusionContributionByChannel.set(score.channel, prior + score.rrfContribution);
      }
    }
    const perChannel: readonly RetrievalChannelTrace[] = [
      buildChannelTrace({
        channel: RETRIEVAL_CHANNEL_SPARSE_BM25,
        active: activeChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25),
        result: sparseResult,
        hits: sparseHits,
        topKInput: sparseTopN,
        fusionContribution: fusionContributionByChannel.get(RETRIEVAL_CHANNEL_SPARSE_BM25) ?? 0,
      }),
      buildChannelTrace({
        channel: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
        active: activeChannels.has(RETRIEVAL_CHANNEL_LEARNED_SPARSE),
        result: learnedSparseResult,
        hits: learnedSparseHits,
        topKInput: sparseTopN,
        fusionContribution: fusionContributionByChannel.get(RETRIEVAL_CHANNEL_LEARNED_SPARSE) ?? 0,
      }),
      buildChannelTrace({
        channel: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
        active: activeChannels.has(RETRIEVAL_CHANNEL_DENSE_SEMANTIC),
        result: denseResult,
        hits: denseHits,
        topKInput: denseTopN,
        fusionContribution: fusionContributionByChannel.get(RETRIEVAL_CHANNEL_DENSE_SEMANTIC) ?? 0,
      }),
      buildChannelTrace({
        channel: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
        active: activeChannels.has(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY) && anchorProfile !== undefined,
        result: anchorResult,
        hits: anchorHits,
        topKInput: denseTopN,
        fusionContribution: fusionContributionByChannel.get(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY) ?? 0,
      }),
    ];

    const fusionTrace: RrfFusionTrace = {
      queryClass: input.queryPlan.queryClass,
      fusionClass: fusionQueryClass,
      rrfK: effectiveFusionK,
      channelWeights: {
        sparse: fusionConfig.sparseWeight,
        dense: fusionConfig.denseWeight,
        anchor: fusionConfig.anchorWeight,
        learnedSparse: fusionConfig.learnedSparseWeight,
      },
      candidateCount: {
        beforeFusion: {
          sparse: sparseHits.length,
          dense: denseHits.length,
          anchor: anchorHits.length,
        },
        afterFusion: countAfterFusion,
        afterHardFilter: countAfterHardFilter,
        afterAssembly: assembled.candidates.length,
      },
      perChannel,
    };
    const resultCandidates = assembled.candidates.map((candidate) => ({
      ...candidate.legacyCandidate,
      retrievalProvenance: candidate.provenance,
    }));
    const lanes: RetrievalExecutionLanes = {
      sparse: toExecutionLane(sparseResult),
      learnedSparse: toExecutionLane(learnedSparseResult),
      dense: toExecutionLane(denseResult),
      anchor: toExecutionLane(anchorResult),
      relative: relativeLane,
    };
    const executionResult = buildRetrievalExecutionResult({
      candidates: resultCandidates,
      lanes,
      degradation: {
        signals: degradationSignals,
        codes: degradationCodes,
      },
      fusionTrace,
      dropLog: hardFilterDrops,
      telemetry: {
        queryClass: input.queryPlan.queryClass,
        route: input.route,
        runtimeRetrievalMode: retrievalMode,
        retrievalProfile: profile.name,
        vespaRankProfile,
        activeChannels: [...activeChannels],
        filtersApplied: filters,
        skippedPhases: effectiveSkippedPhases,
      },
    });
    this._lastExecutionResult = executionResult;

    pipelineDebug(
      {
        step: 'retrieval.candidate_pool.assembled',
        query_class: input.queryPlan.queryClass,
        profile: profile.name,
        vespa_rank_profile: vespaRankProfile,
        sparse_hits: sparseHits.length,
        learned_sparse_hits: learnedSparseHits.length,
        dense_hits: denseHits.length,
        anchor_hits: anchorHits.length,
        skipped_phases: skippedPhases,
        final_candidates: assembled.candidates.length,
        // S4.1 — surface soft→hard promotion in the HTTP pipeline_debug trace
        // so a single debugged request shows whether promotion fired and how
        // many tokens reached the final YQL filter set.
        promoted_soft_filter_count: promotedSoftFilterTokens.length,
        promoted_soft_filter_tokens: promotedSoftFilterTokens,
        yql_filter_token_count: filters.length,
      },
      'pipeline candidate pool',
    );

    return executionResult;
  }

  /**
   * @deprecated Use execute() for RetrievalExecutorV2 contract.
   */
  async generate(input: HybridRetrievalInput): Promise<RetrievalExecutionResult> {
    return this.execute(input);
  }

  /**
   * E4: Returns the RRF fusion trace from the most recent execute() call.
   * Returns undefined before the first execute() call.
   * Mirrors the getLastFunnelMetrics() pattern on RankingPort.
   */
  getLastFusionTrace(): RrfFusionTrace | undefined {
    return this._lastExecutionResult?.fusionTrace;
  }

  /**
   * E4: Returns the hard-filter drop log from the most recent execute() call.
   * Empty array before the first execute() call or when no candidates were dropped.
   */
  getLastDropLog(): readonly CandidateDropRecord[] {
    return this._lastExecutionResult?.dropLog ?? [];
  }

  /**
   * Bugbash 2026-04-14: returns structured retrieval degradation signals from
   * the most recent execute() call. Consumed by search-usecase-hybrid-candidates
   * to merge into route-level `routeDegradation.degradationReasons` so the HTTP
   * wire contract reflects sub-channel failures. Empty array before any execute()
   * or when no degradations occurred.
   */
  getLastDegradationSignals(): readonly RetrievalDegradationSignal[] {
    return this._lastExecutionResult?.degradationSignals ?? [];
  }

  /**
   * Critic-facing structured degradation categories derived from the
   * most recent execute() call. Empty before the first call or when no
   * production-reachable sparse/no-match condition was observed.
   */
  getLastDegradationCodes(): readonly RetrievalDegradationCode[] {
    return this._lastExecutionResult?.degradationCodes ?? [];
  }

  /**
   * Heuristic estimate of alias match strength for cascade routing.
   * CandidatePool intentionally stays downstream of planning/anchor extraction,
   * so it uses anchor confidence propagated by the planner rather than reaching
   * back into alias infrastructure a second time.
   */
  private estimateAliasStrength(input: HybridRetrievalInput): number {
    const anchors = input.queryPlan.anchors;
    if (anchors.length === 0) {
      return 0;
    }
    // Use the highest anchor confidence as a proxy for alias match strength.
    // Loop instead of Math.max(...spread) to avoid stack overflow on adversarial
    // inputs that produce tens of thousands of anchors.
    let max = -Infinity;
    for (const a of anchors) {
      if (a.confidence > max) max = a.confidence;
    }
    return max;
  }

  /**
   * Deterministic exact-anchor lock.
   *
   * When planning has already collapsed the query onto a single anchor entity
   * under `entity_exact` / `mixed_query`, semantic dense expansion is more likely
   * to dilute the exact target than to help. In that case we keep lexical +
   * anchor-ANN and suppress generic semantic ANN.
   */
  private isDeterministicExactAnchorQuery(input: HybridRetrievalInput): boolean {
    const intent = input.queryPlan.intent;
    if (intent !== 'entity_exact' && intent !== 'mixed_query') {
      return false;
    }
    if (input.queryPlan.queryClass === 'ambiguous_short_form') {
      return false;
    }

    const uniqueEntityIds = new Set(
      input.queryPlan.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
    );
    return uniqueEntityIds.size === 1;
  }

  private resolveRuntimeRetrievalMode(input: HybridRetrievalInput): RuntimeRetrievalMode {
    if (input.compiledRetrievalMode === undefined) {
      throw new Error('CandidatePoolService requires compiledRetrievalMode from compiled execution');
    }
    const baseMode = input.compiledRetrievalMode;
    if (baseMode === 'compare_candidates' && input.anchorEntityId !== undefined) {
      return 'relative';
    }
    // TRACK-A A4: exact_entity / short_entity WITH non-empty anchors → anchor-first dual path.
    // The planner has resolved at least one entity with a confidence score — prioritise the
    // entity-anchor channel in fusion so the exact target surfaces at rank 1.
    // Condition: queryClass is exact_entity or short_entity AND anchors array is non-empty.
    // No override when baseMode is already a specialised mode (producer_browse, etc.) —
    // those paths handle their own routing.
    const isEntityQueryClass =
      input.queryPlan.queryClass === 'exact_entity' ||
      input.queryPlan.queryClass === 'short_entity';
    const hasAnchors = input.queryPlan.anchors.length > 0;
    // Allow entity_anchor_first override only when the base mode is absent or a
    // generic entity lookup mode. Specialised modes (producer_browse, region_browse,
    // compare_candidates, etc.) handle their own routing and must not be overridden.
    const noSpecialMode = !ANCHOR_FIRST_BLOCKED_MODES.has(baseMode);
    if (isEntityQueryClass && hasAnchors && noSpecialMode) {
      return 'entity_anchor_first';
    }
    return baseMode;
  }

  private resolveActiveChannels(
    profileChannels: readonly CandidateChannel[],
    dispatchDecision: ReturnType<CascadeRouter['getDispatchDecision']>,
    input: HybridRetrievalInput,
    runtimeMode?: string,
  ): ReadonlySet<CandidateChannel> {
    const dispatchChannels = new Set(dispatchDecision.channelsToActivate);
    const active = new Set<CandidateChannel>();
    const exactAnchorLocked =
      runtimeMode === 'entity_anchor_first' &&
      this.isDeterministicExactAnchorQuery(input);

    for (const channel of profileChannels) {
      // Deterministic exact-anchor lock: when planning already resolved a single
      // anchor entity for an entity/mixed query, keep the anchor ANN plus lexical
      // evidence and suppress generic semantic ANN. This prevents exact targets
      // like Opus One from being diluted by nearby semantic neighbors.
      if (exactAnchorLocked) {
        if (channel === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY || channel === RETRIEVAL_CHANNEL_SPARSE_BM25) {
          active.add(channel);
        }
        continue;
      }

      if (dispatchChannels.has(channel)) {
        active.add(channel);
        continue;
      }

      if (channel === RETRIEVAL_CHANNEL_LEARNED_SPARSE && dispatchChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25) && !this.killSwitchLearning) {
        active.add(channel);
        continue;
      }

      if (channel === RETRIEVAL_CHANNEL_RELATIVE_FILTER && input.anchorEntityId !== undefined) {
        active.add(channel);
        continue;
      }

      // TRACK-A A4: entity_anchor_first mode activates all three of its channels
      // regardless of cascade difficulty.  The cascade router routes exact_entity /
      // short_entity to 'easy' (sparse only) when aliasMatchStrength ≥ 0.9, which
      // would otherwise suppress both anchor_similarity and dense_semantic.  We
      // intentionally override that suppression — the profile includes all three
      // channels and the whole purpose of entity_anchor_first is to run the anchor
      // ANN pass.  dense_semantic is kept (damped in future weighted fusion) because
      // it fills the pool with nearby wines that may not have exact-match BM25 hits.
      if (runtimeMode === 'entity_anchor_first' && (
        channel === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY ||
        channel === RETRIEVAL_CHANNEL_DENSE_SEMANTIC ||
        channel === RETRIEVAL_CHANNEL_SPARSE_BM25
      )) {
        active.add(channel);
        continue;
      }
    }

    if (active.size === 0) {
      active.add(RETRIEVAL_CHANNEL_SPARSE_BM25);
    }

    // T-IR-01: hard-cap the resolved channel set to the caller-selected
    // retrieval lane. Applied LAST so it overrides every profile/cascade
    // activation above — `/v1/search/semantic` must never run a sparse leg
    // and `/v1/search/lexical` must never run a dense/anchor leg, regardless
    // of which intent profile the planner picked.
    return this.applyRetrievalLaneFilter(active, input.retrievalLane);
  }

  /**
   * Restrict an already-resolved active-channel set to the caller-selected
   * retrieval lane. `'hybrid'` (or absent) is a no-op. The empty-set fallback
   * is lane-aware: a `'semantic_only'` request that filtered every channel
   * falls back to dense (NOT sparse) so the lane invariant holds even on the
   * degenerate path.
   */
  private applyRetrievalLaneFilter(
    channels: ReadonlySet<CandidateChannel>,
    lane: HybridRetrievalInput['retrievalLane'],
  ): ReadonlySet<CandidateChannel> {
    if (lane === undefined || lane === 'hybrid') {
      return channels;
    }
    const filtered = new Set<CandidateChannel>();
    for (const channel of channels) {
      if (lane === 'semantic_only') {
        if (
          channel === RETRIEVAL_CHANNEL_DENSE_SEMANTIC
          || channel === RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY
          || channel === RETRIEVAL_CHANNEL_RELATIVE_FILTER
        ) {
          filtered.add(channel);
        }
        continue;
      }
      // lane === 'lexical_only'
      if (
        channel === RETRIEVAL_CHANNEL_SPARSE_BM25
        || channel === RETRIEVAL_CHANNEL_LEARNED_SPARSE
      ) {
        filtered.add(channel);
      }
    }
    if (filtered.size === 0) {
      filtered.add(
        lane === 'semantic_only'
          ? RETRIEVAL_CHANNEL_DENSE_SEMANTIC
          : RETRIEVAL_CHANNEL_SPARSE_BM25,
      );
    }
    return filtered;
  }

  private shouldExecutePhase(
    phase: RetrievalPhase,
    activeChannels: ReadonlySet<CandidateChannel>,
  ): boolean {
    switch (phase) {
      case 'sparse':
        return activeChannels.has(RETRIEVAL_CHANNEL_SPARSE_BM25);
      case 'learned_sparse':
        return activeChannels.has(RETRIEVAL_CHANNEL_LEARNED_SPARSE);
      case 'dense':
        return activeChannels.has(RETRIEVAL_CHANNEL_DENSE_SEMANTIC);
      case 'anchor_neighborhood':
        return activeChannels.has(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY);
      case 'relative':
        return activeChannels.has(RETRIEVAL_CHANNEL_RELATIVE_FILTER);
    }
  }

  private async loadAnchorDocumentIfNeeded(
    input: HybridRetrievalInput,
    activeChannels: ReadonlySet<CandidateChannel>,
    runtimeMode?: string,
  ): Promise<RetrievalDocument | undefined> {
    const needsAnchorChannel =
      activeChannels.has(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY) || activeChannels.has(RETRIEVAL_CHANNEL_RELATIVE_FILTER);
    if (!needsAnchorChannel) {
      return undefined;
    }

    // Prefer the explicit anchorEntityId from the input (set by compare_candidates
    // path).  TRACK-A A4: for entity_anchor_first mode the input may not carry an
    // explicit anchorEntityId — derive it from the first planner anchor instead.
    let resolvedAnchorEntityId = input.anchorEntityId;
    if (resolvedAnchorEntityId === undefined && runtimeMode === 'entity_anchor_first') {
      // Anchors are sorted by confidence at planning time; take the first candidate
      // entity ID of the highest-confidence anchor.  candidateEntityIds is always
      // non-empty when an anchor is emitted (empty arrays are pruned by the planner).
      const firstAnchor = input.queryPlan.anchors[0];
      const firstEntityId = firstAnchor?.candidateEntityIds[0];
      resolvedAnchorEntityId = firstEntityId;
    }

    if (resolvedAnchorEntityId === undefined) {
      return undefined;
    }

    const anchorDocument = await this.searchIndex.getDocument(resolvedAnchorEntityId);
    return anchorDocument ?? undefined;
  }

  private resolveAnchorProfile(
    input: HybridRetrievalInput,
    anchorDocument: RetrievalDocument | undefined,
  ): HybridRetrievalInput['anchorProfile'] {
    if (input.anchorProfile !== undefined) {
      return input.anchorProfile;
    }

    if (anchorDocument === undefined) {
      return undefined;
    }

    return {
      semanticSummary: anchorDocument.semanticSummary,
      ...(anchorDocument.embedding !== undefined
        ? { embedding: anchorDocument.embedding }
        : {}),
      anchorConfidence: input.queryPlan.anchors[0]?.confidence ?? HYBRID_ANCHOR_CONFIDENCE_DEFAULT,
    };
  }
}

/**
 * Wave 2 — derive a single `RetrievalChannelTrace` row from a channel's
 * lane result. The mapping is deterministic and documented:
 *
 *  - When the channel was not selected for this request (`active=false`)
 *    AND the lane was not invoked → `dormant`. This is the EXPECTED off
 *    state; operators do NOT alert on it.
 *  - When the lane reported `infra_failure` AND classified its error as
 *    `circuit_breaker_open` / `timeout` → surface that exact kind.
 *  - When the lane reported `infra_failure` from any other class →
 *    `error` (still degraded, but not breaker-open / timeout).
 *  - Otherwise (`ok` / `empty` / `disabled` with active=true and no
 *    degradation) → `active`. `disabled` happens when the channel is
 *    administratively gated (e.g. dense kill switch); we map it to
 *    `dormant` so dashboards don't read "active 0 hits" for an
 *    operator-disabled channel.
 */
function buildChannelTrace(input: {
  readonly channel: CandidateChannel;
  readonly active: boolean;
  readonly result: {
    readonly status: RetrievalLaneStatus;
    readonly degraded: boolean;
    readonly degradation?: {
      readonly errorKind?: 'circuit_breaker_open' | 'timeout' | 'error' | undefined;
    } | undefined;
  };
  readonly hits: ReadonlyArray<unknown>;
  readonly topKInput: number;
  readonly fusionContribution: number;
}): RetrievalChannelTrace {
  let firingState: RetrievalChannelFiringState;
  if (input.result.status === 'disabled' || !input.active) {
    firingState = 'dormant';
  } else if (input.result.status === 'infra_failure') {
    const kind = input.result.degradation?.errorKind ?? 'error';
    firingState = kind;
  } else {
    firingState = 'active';
  }
  return {
    channel: input.channel,
    firingState,
    hitCount: input.hits.length,
    // When the channel did not run, the top-K it WOULD have used is
    // meaningless to operators — report 0 to keep the row truthful.
    topKInput: firingState === 'dormant' ? 0 : input.topKInput,
    fusionContribution: input.fusionContribution,
  };
}

function toExecutionLane<THit>(
  lane: {
    readonly status: RetrievalLaneStatus;
    readonly hits: readonly THit[];
    readonly degraded: boolean;
    readonly degradation?: { readonly reason: string } | undefined;
  },
): RetrievalExecutionLane<THit> {
  return {
    status: lane.status,
    hits: lane.hits,
    degraded: lane.degraded,
    error: lane.degradation?.reason,
  };
}

/**
 * Maps a retrieval mode to the Vespa rank profile that best serves it.
 *
 * - producer_browse / region_browse → `prestige_hybrid`: blends BM25+ANN with
 *   critic score (35%) and producer prestige (25%), surfacing quality-first results
 *   without a second post-retrieval rerank pass.
 * - compare_candidates / relative → `prestige_hybrid`: head-to-head comparisons
 *   benefit from the same quality-first signal set.
 * - discovery / recommendation / occasion → `wine_aware`: full domain signals with
 *   2-phase reranking; adds availability boost, critic score, vintage freshness,
 *   and drinking-window proximity on top of hybrid phase-1. Best for "find me a wine"
 *   queries where domain quality signals matter most.
 * - everything else → `hybrid`: normalized BM25+ANN+popularity for standard search.
 */
function resolveVespaRankProfile(retrievalMode: string | undefined): string {
  switch (retrievalMode) {
    case 'producer_browse':
    case 'region_browse':
    case 'compare_candidates':
    case 'relative':
      return 'prestige_hybrid';
    case 'discovery':
    case 'recommendation':
    case 'occasion':
      return 'wine_aware';
    default:
      return 'hybrid';
  }
}

function buildAssemblyPolicy(maxTotal: number): AssemblyPolicy {
  return {
    maxTotal,
    protectExactMatches: true,
    protectAnchorConditioned: true,
  };
}

function resolveExplorationTopN(
  profileTopN: number,
  executionBudgetMaxCandidates?: number,
): number {
  if (
    executionBudgetMaxCandidates === undefined
    || !Number.isFinite(executionBudgetMaxCandidates)
    || executionBudgetMaxCandidates <= 0
  ) {
    return profileTopN;
  }
  return Math.min(profileTopN, Math.trunc(executionBudgetMaxCandidates));
}

function toCandidateChannels(candidate: HybridCandidate): CandidateChannel[] {
  const channels: CandidateChannel[] = [];
  const seenChannels = new Set<CandidateChannel>();
  const pushChannel = (channel: CandidateChannel): void => {
    if (!seenChannels.has(channel)) {
      seenChannels.add(channel);
      channels.push(channel);
    }
  };
  if (candidate.sparseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_SPARSE_BM25);
  if (candidate.denseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_DENSE_SEMANTIC);
  if (candidate.learnedSparseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_LEARNED_SPARSE);
  if (candidate.anchorRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY);

  for (const source of candidate.retrievalTrace.candidateSources) {
    const canonicalSource = toCanonicalCandidateChannel(source);
    if (canonicalSource !== null) {
      pushChannel(canonicalSource);
    }
  }

  return channels;
}

// toCanonicalCandidateChannel + isCandidateChannel: imported from retrieval-channel.ts (SSoT)

function normalizeCandidateChannelScores(
  channelScores: CandidateEnvelope['provenance']['channelScores'],
): CandidateEnvelope['provenance']['channelScores'] {
  return channelScores.flatMap((score) => {
    const canonical = toCanonicalCandidateChannel(score.channel);
    return canonical === null ? [] : [{ ...score, channel: canonical }];
  });
}

function normalizeCandidateQueryViewMatches(
  queryViewMatches: readonly QueryViewMatch[],
): CandidateEnvelope['provenance']['queryViewMatches'] {
  const seen = new Set<string>();
  const normalized: QueryViewMatch[] = [];

  for (const match of queryViewMatches) {
    const canonical = toCanonicalCandidateChannel(match.channel);
    if (canonical === null) {
      continue;
    }
    const next = { ...match, channel: canonical } satisfies QueryViewMatch;
    const key = `${next.viewName}\u0000${next.matchedText}\u0000${next.channel}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(next);
    }
  }

  return normalized;
}

function normalizeCandidateProvenance(
  provenance: CandidateEnvelope['provenance'],
): CandidateEnvelope['provenance'] {
  const channels: CandidateChannel[] = [];
  const seenChannels = new Set<CandidateChannel>();
  for (const channel of provenance.channels) {
    const canonical = toCanonicalCandidateChannel(channel);
    if (canonical !== null && !seenChannels.has(canonical)) {
      seenChannels.add(canonical);
      channels.push(canonical);
    }
  }

  return {
    ...provenance,
    channels,
    channelScores: normalizeCandidateChannelScores(provenance.channelScores),
    queryViewMatches: normalizeCandidateQueryViewMatches(provenance.queryViewMatches),
  };
}

function toCandidateProvenance(
  provenance: CandidateEnvelope['provenance'],
): CandidateEnvelope['provenance'] {
  const normalized = normalizeCandidateProvenance(provenance);
  const result = CandidateProvenanceV2Schema.safeParse(normalized);
  if (!result.success) {
    bootstrapLogger.warn(
      { issues: result.error.issues },
      '[CandidatePool] toCandidateProvenance: schema validation failed — using raw normalized provenance',
    );
    return normalized;
  }
  const parsed = result.data;
  return {
    channels: parsed.channels,
    channelScores: parsed.channelScores,
    queryViewMatches: parsed.queryViewMatches,
    anchorConditioned: parsed.anchorConditioned,
    matchedFilterConstraints: parsed.matchedFilterConstraints,
    ...(parsed.failedHardConstraints !== undefined
      ? { failedHardConstraints: parsed.failedHardConstraints }
      : {}),
    ...(parsed.protectedInclusionReason !== undefined
      ? { protectedInclusionReason: parsed.protectedInclusionReason }
      : {}),
    fusionProfile: parsed.fusionProfile,
    fusionScore: parsed.fusionScore,
  };
}

function hybridCandidateToEnvelope(
  candidate: HybridCandidate,
  fusionK: number,
): CandidateEnvelope {
  if (candidate.retrievalProvenance !== undefined) {
    const provenance = toCandidateProvenance(candidate.retrievalProvenance);
    return {
      entityId: candidate.entityId,
      provenance,
      legacyCandidate: {
        ...candidate,
        retrievalTrace: {
          ...candidate.retrievalTrace,
          candidateSources: preferCanonicalRetrievalChannelLabels(
            candidate.retrievalTrace.candidateSources,
          ),
        },
      },
    };
  }

  const channels = toCandidateChannels(candidate);
  const channelScores = [];

  // Bugbash 2026-04-09 (Group C): per-channel raw scores must never be
  // fabricated from any fused score. Missing per-channel raw means missing
  // evidence, not "reuse the fusion total".
  // Contract: when a per-channel rank is present but the matching raw is
  // missing, we log a warning and SKIP that channel entry rather than
  // fabricating an incorrect rawScore.
  if (candidate.sparseRank !== undefined) {
    if (candidate.sparseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_SPARSE_BM25,
        rawScore: candidate.sparseRawScore,
        rank: candidate.sparseRank,
        rrfContribution: rrfContribution(candidate.sparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_SPARSE_BM25,
          rank: candidate.sparseRank,
        },
        'hybridCandidateToEnvelope: sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.denseRank !== undefined) {
    if (candidate.denseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
        rawScore: candidate.denseRawScore,
        rank: candidate.denseRank,
        rrfContribution: rrfContribution(candidate.denseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
          rank: candidate.denseRank,
        },
        'hybridCandidateToEnvelope: dense channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.learnedSparseRank !== undefined) {
    if (candidate.learnedSparseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
        rawScore: candidate.learnedSparseRawScore,
        rank: candidate.learnedSparseRank,
        rrfContribution: rrfContribution(candidate.learnedSparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
          rank: candidate.learnedSparseRank,
        },
        'hybridCandidateToEnvelope: learned_sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.anchorRank !== undefined) {
    if (candidate.anchorRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
        rawScore: candidate.anchorRawScore,
        rank: candidate.anchorRank,
        rrfContribution: rrfContribution(candidate.anchorRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
          rank: candidate.anchorRank,
        },
        'hybridCandidateToEnvelope: anchor channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }

  const provenance = {
    channels,
    channelScores,
    queryViewMatches: [],
    anchorConditioned: candidate.anchorRank !== undefined,
    matchedFilterConstraints: candidate.matchedConstraints,
    ...(candidate.unmetHardConstraints !== undefined
      ? { failedHardConstraints: candidate.unmetHardConstraints }
      : {}),
    fusionProfile: candidate.retrievalTrace.retrievalProfile,
    // fusionRrfTotal: set by FusionService only. Non-fusion candidates (Browse/Compare/similar)
    // fall back to sparseRawScore (their canonical per-channel score). Default 0 is safe —
    // these candidates are ranked by signal-computer, not by this fallback fusionScore.
    fusionScore: candidate.fusionRrfTotal ?? candidate.sparseRawScore ?? 0,
  } satisfies CandidateEnvelope['provenance'];
  const normalizedProvenance = toCandidateProvenance(provenance);

  return {
    entityId: candidate.entityId,
    provenance: normalizedProvenance,
    legacyCandidate: {
      ...candidate,
      retrievalTrace: {
        ...candidate.retrievalTrace,
        candidateSources: preferCanonicalRetrievalChannelLabels(
          candidate.retrievalTrace.candidateSources,
        ),
      },
      retrievalProvenance: normalizedProvenance,
    },
  };
}

function buildLearnedSparseQueryWeights(
  input: HybridRetrievalInput,
): readonly { token: string; weight: number }[] {
  const counts = new Map<string, number>();
  const sourceQueries = [...input.lexicalQueries, ...input.semanticQueries];

  for (const query of sourceQueries) {
    for (const token of query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  for (const boost of [
    ...(input.retrievalPlan?.softBoosts ?? []),
    ...(input.retrievalPlan?.inferredBoosts ?? []),
  ]) {
    const boostTokens = retrievalValueToTokens(boost.value);
    for (const token of boostTokens) {
      // Math.max(0, ...) prevents negative weights from corrupting counts.
      // Previously Math.max(1, ...) was used but that clamps all [0,1]-range weights to 1,
      // discarding calibrated confidence signal entirely — high-confidence (0.95) and
      // low-confidence (0.07) boosts received identical increments of 1.
      counts.set(token, (counts.get(token) ?? 0) + Math.max(0, Number.isFinite(boost.weight) ? boost.weight : 0));
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const diff = right[1] - left[1];
      const primary = Number.isFinite(diff) ? diff : 0;
      // Deterministic tiebreaker: avoid localeCompare() which is locale-dependent
      // and produces different token orderings across systems (CLAUDE.md rule 21).
      // Tokens are ASCII-safe query terms so simple lexicographic comparison is correct.
      return primary !== 0 ? primary : (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    })
    .slice(0, QUERY_EXPANSION_MAX_TERMS)
    .map(([token, count]) => ({
      token,
      weight: 1 + (count - 1) * QUERY_EXPANSION_TERM_WEIGHT_STEP,
    }));
}

function retrievalValueToTokens(value: HybridRetrievalInput['hardConstraints'][number]['value']): readonly string[] {
  if (typeof value === 'string') {
    return tokenizeRetrievalValue(value);
  }
  if (typeof value === 'number') {
    return [value.toString()];
  }
  if (Array.isArray(value)) {
    const tokens: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        tokens.push(...tokenizeRetrievalValue(entry));
      }
    }
    return tokens;
  }
  return [];
}

function tokenizeRetrievalValue(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}
