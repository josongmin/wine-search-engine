import type { SearchIndexPort, DenseHit, SparseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type {
  CandidateChannel,
  CandidateDropRecord,
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
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_RELATIVE_FILTER,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  type RetrievalChannel,
} from '../model/retrieval-channel.js';

import { EMBEDDING_MODEL } from '../../shared/constants/embedding.js';
import { type FusionService, NEUTRAL_FUSION_WEIGHTS, type FusionWeights } from './fusion.js';
import { RetrievalProfileService } from './retrieval-profile.js';
import {
  getFusionConfig,
  mapDomainQueryClassToFusionQueryClass,
} from './per-class-fusion-config.js';
import { CascadeRouter, type RetrievalPhase } from './cascade-router.js';
import { ConstraintFilter } from './constraint-filter.js';
import type {
  RetrievalProfilePort,
  CascadeRouterPort,
  ConstraintFilterPort,
  CandidateAssemblerPort,
} from '../port/candidate-pool-collaborators.port.js';
import {
  hardConstraintsToSparseFilterTokens,
  softConstraintsToOptionalFilterTokens,
} from './constraint-to-sparse-filter-tokens.js';
import {
  validateConstraintBundle,
  emitConstraintValidationTelemetry,
} from './constraint-validator.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { CandidateAssembler } from './candidate-assembly.js';
import {
  hasStructuredPriceConstraint,
  buildRawQueryPriceConstraints,
} from './candidate-pool-price-constraints.js';
import {
  resolveVespaRankProfile,
  buildAssemblyPolicy,
  resolveExplorationTopN,
} from './candidate-pool-rank-profile.js';
import {
  classifyChannelError,
  buildChannelTrace,
  toExecutionLane,
} from './candidate-pool-channel-trace.js';
import { buildLearnedSparseQueryWeights } from './candidate-pool-learned-sparse-query.js';
import {
  type RuntimeRetrievalMode,
  estimateAliasStrength,
  isDeterministicExactAnchorQuery,
  resolveRuntimeRetrievalMode,
  applyRetrievalLaneFilter,
  shouldExecutePhase,
  resolveAnchorProfile,
} from './candidate-pool-mode-routing.js';
import { hybridCandidateToEnvelope } from './candidate-pool-provenance.js';
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

function isSearchSubstrateUnavailable(searchIndex: SearchIndexPort): boolean {
  return searchIndex.getSearchAvailabilityState?.() === 'unavailable';
}

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

// `RuntimeRetrievalMode` is owned by ./candidate-pool-mode-routing.ts and
// re-exported here to preserve the original public import path.
export type { RuntimeRetrievalMode };

export class CandidatePoolService implements RetrievalExecutorV2Port {
  private readonly profileService: RetrievalProfilePort;
  private readonly cascadeRouter: CascadeRouterPort;
  private readonly constraintFilter: ConstraintFilterPort;
  private readonly candidateAssembler: CandidateAssemblerPort;
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
    /**
     * DIP seam (behavior-preserving): the four collaborators default to the
     * same concrete implementations that were previously hard-`new`-ed here,
     * so existing callers (which pass none of these) get byte-identical
     * runtime behavior. Tests may inject mocks via these optional params.
     */
    profileService: RetrievalProfilePort = new RetrievalProfileService(),
    cascadeRouter: CascadeRouterPort = new CascadeRouter(),
    constraintFilter: ConstraintFilterPort = new ConstraintFilter(),
    candidateAssembler: CandidateAssemblerPort = new CandidateAssembler(),
  ) {
    this.profileService = profileService;
    this.cascadeRouter = cascadeRouter;
    this.constraintFilter = constraintFilter;
    this.candidateAssembler = candidateAssembler;
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
    const retrievalMode = resolveRuntimeRetrievalMode(input);
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
    const aliasMatchStrength = estimateAliasStrength(input);
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
    const skippedPhases = allPhases.filter((phase) => !shouldExecutePhase(phase, activeChannels));

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
    const anchorProfile = resolveAnchorProfile(input, anchorDocument);

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
      isDeterministicExactAnchorQuery(input);

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
    return applyRetrievalLaneFilter(active, input.retrievalLane);
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
}
