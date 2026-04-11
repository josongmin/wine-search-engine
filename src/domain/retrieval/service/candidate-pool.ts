import type { SearchIndexPort, DenseHit, SparseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type {
  CandidateEnvelope,
  CandidateChannel,
  CandidateDropRecord,
  QueryViewMatch,
  RrfFusionTrace,
} from '../model/candidate-envelope.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import { CandidateProvenanceV2Schema } from '../model/retrieval-contract-v2.js';
import {
  preferCanonicalRetrievalChannelLabels,
  toCanonicalCandidateChannel,
} from '../model/retrieval-channel.js';
import { rrfContribution } from '../../shared/utils/rrf.js';
import { type FusionService } from './fusion.js';
import { RetrievalProfileService } from './retrieval-profile.js';
import {
  getFusionConfig,
  mapDomainQueryClassToFusionQueryClass,
} from './per-class-fusion-config.js';
import { CascadeRouter, type RetrievalPhase } from './cascade-router.js';
import { estimateQueryDifficulty } from './query-difficulty-estimator.js';
import { ConstraintFilter } from './constraint-filter.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import {
  extractSearchConstraints,
  searchConstraintsToFilterTokens,
} from '../../query/service/search-constraint-extractor.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { CandidateAssembler, type AssemblyPolicy } from './candidate-assembly.js';
import { applyProtectedRecallPolicy } from './protected-recall-policy.js';
import { accumulateEvidence } from './evidence-accumulator.js';
import { applyRelativeFilter } from './relative-filter-policy.js';
import { combineSemanticEmbeddings } from './semantic-embedding-combiner.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';
import type { CacheService } from '../../performance/index.js';
import type { RetrievalDegradationObserver } from '../port/retrieval-degradation-observer.port.js';
import type { RetrievalExecutorV2Port } from '../port/retrieval-executor-v2.port.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { pipelineDebug } from '../../../observability/request-pipeline-debug.js';
import { deriveQueryFamily } from '../../query/model/query-observability-vocab.js';

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
  /** E4: Last RRF fusion trace, populated after each execute() call. */
  private _lastFusionTrace: RrfFusionTrace | undefined = undefined;
  /** E4: Drop log from the most recent execute() call's hard-filter step. */
  private _lastDropLog: readonly CandidateDropRecord[] = [];

  constructor(
    private readonly searchIndex: SearchIndexPort,
    private readonly embeddingService: EmbeddingServicePort,
    private readonly fusionService: FusionService,
    private readonly cacheService?: CacheService | undefined,
    private readonly embeddingModelId: string = 'bge-m3',
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
  async execute(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
    this.degradationObserver?.onRetrievalStarted();
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

    // Epic-16 / T16-4 parallel wire-up: compute query difficulty via the
    // deterministic estimator alongside the CascadeRouter's signal-based
    // difficulty. The two estimators consume different signal shapes and
    // cannot be substituted 1:1 without risk — this emits an agreement
    // log so sweeps can quantify drift before a full replacement. No
    // behavior change: the cascade continues to use dispatchDecision.
    {
      const normalizedQuery = input.queryPlan.normalizedQuery;
      const tokenCount = normalizedQuery.trim().length === 0
        ? 0
        : normalizedQuery.trim().split(/\s+/).length;
      const estimate = estimateQueryDifficulty({
        normalizedQuery,
        tokenCount,
        hasAnchor: anchorConfidence > 0,
        anchorConfidence,
        hasNumericConstraint:
          input.hardConstraints.length + input.softConstraints.length > 0,
        // RFC-005 query classes do not surface a negation signal yet;
        // pass false so the estimator never short-circuits to 'hard' on
        // this axis. Revisit when a negation extractor lands.
        hasNegation: false,
      });
      bootstrapLogger.debug(
        {
          event: 'retrieval.difficulty_parallel',
          cascade_difficulty: dispatchDecision.difficulty,
          estimator_difficulty: estimate.difficulty,
          estimator_score: estimate.score,
          agree: dispatchDecision.difficulty === estimate.difficulty,
          query_class: input.queryPlan.queryClass,
        },
        'cascade vs estimator difficulty',
      );
    }
    const activeChannels = this.resolveActiveChannels(profile.channelMix, dispatchDecision, input, retrievalMode);
    const allPhases: RetrievalPhase[] = [
      'sparse',
      'learned_sparse',
      'dense',
      'anchor_neighborhood',
      'relative',
    ];
    const skippedPhases = allPhases.filter((phase) => !this.shouldExecutePhase(phase, activeChannels));

    // Vespa sparse filter tokens (aligned with browse/compare + buildSparseFilters)
    const filters = [...hardConstraintsToSparseFilterTokens(input.hardConstraints)];

    // KRW price constraints from the raw query surface (e.g. "5만원대", "3만원 이하").
    // extractSearchConstraints parses Korean price expressions that the planner's
    // NormalizedConstraint system does not yet capture. The resulting
    // price_usd_min / price_usd_max tokens are understood by buildSparseFilters
    // and buildDenseFilters in mapping.ts and applied as hard YQL filters.
    const rawQuery = input.queryPlan.rawQuery;
    if (rawQuery.length > 0) {
      const krwConstraints = extractSearchConstraints(rawQuery);
      const krwTokens = searchConstraintsToFilterTokens(krwConstraints);
      // Only add price tokens — exclusion/vintage tokens are already handled
      // via hardConstraints. Adding them twice would produce duplicate YQL clauses.
      const priceTokens = krwTokens.filter(
        (t) => t.startsWith('price_usd_min:') || t.startsWith('price_usd_max:'),
      );
      filters.push(...priceTokens);
    }
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
      readonly component: 'sparse_bm25' | 'learned_sparse' | 'dense_semantic' | 'embedding_combiner' | 'anchor_similarity';
      readonly severity: 'error' | 'warning';
      readonly reason: string;
      readonly fallbackApplied: string;
    };

    type SparseResult = {
      readonly hits: readonly SparseHit[];
      readonly degraded: boolean;
      readonly degradation?: DegradationReport;
    };
    type DenseLikeResult = {
      readonly hits: readonly DenseHit[];
      readonly degraded: boolean;
      readonly degradation?: DegradationReport;
    };
    type AnchorResult = {
      readonly hits: readonly DenseHit[] | undefined;
      readonly degradation?: DegradationReport;
    };

    const sparseTask = async (): Promise<SparseResult> => {
      if (!activeChannels.has('sparse_bm25')) {
        return { hits: [], degraded: false };
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
        return { hits: [], degraded: false };
      }
      try {
        const hits = await this.searchIndex.sparseSearch(
          effectiveLexicalQueries,
          filtersOrUndefined,
          profile.sparseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits, degraded: false };
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
          degraded: true,
          degradation: {
            component: 'sparse_bm25',
            severity: 'error',
            reason: sparseErr instanceof Error ? sparseErr.message : 'sparse search failed',
            fallbackApplied: 'dense-only retrieval',
          },
        };
      }
    };

    const learnedSparseTask = async (): Promise<DenseLikeResult> => {
      // W0-2: single gate via killSwitchLearning. Active channel resolution
      // already excludes learned_sparse when killSwitchLearning is true (see
      // resolveActiveChannels), so this guard is the canonical channel check.
      if (!activeChannels.has('learned_sparse')) {
        return { hits: [], degraded: false };
      }
      try {
        const hits = await this.searchIndex.searchLearnedSparse(
          buildLearnedSparseQueryWeights(input),
          filtersOrUndefined,
          profile.sparseTopN,
          requestId,
        );
        return { hits, degraded: false };
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
          degraded: false,
          degradation: {
            component: 'learned_sparse',
            severity: 'warning',
            reason: learnedErr instanceof Error ? learnedErr.message : 'learned sparse search failed',
            fallbackApplied: 'continue without learned sparse',
          },
        };
      }
    };

    const denseTask = async (): Promise<DenseLikeResult> => {
      // T02-2: Dense kill switch pre-flight guard. Skip embedding fetch +
      // denseSearch entirely so we don't pay embedding API cost when dense
      // is administratively disabled. Distinct from per-request degradation.
      if (this.killSwitchDenseRetrieval) {
        return {
          hits: [],
          degraded: true,
          degradation: {
            component: 'dense_semantic',
            severity: 'warning',
            reason: 'dense kill switch enabled',
            fallbackApplied: 'sparse-only retrieval',
          },
        };
      }
      if (!(activeChannels.has('dense_semantic') && input.semanticQueries.length > 0)) {
        return { hits: [], degraded: false };
      }
      try {
        const embeddings = this.cacheService
          ? await this.cacheService.getOrEmbedBatch(
              input.semanticQueries,
              this.embeddingModelId,
              this.embeddingService,
            )
          : await this.embeddingService.embedBatch(input.semanticQueries);

        const validEmbeddings = embeddings.filter(
          (embedding): embedding is readonly number[] => embedding !== null,
        );
        const primaryEmbedding = combineSemanticEmbeddings(validEmbeddings);
        // Reject both undefined AND empty embeddings — an empty Float32Array
        // is truthy but produces nonsense ANN results / Vespa errors downstream.
        if (!primaryEmbedding || primaryEmbedding.length === 0) {
          globalSilentSkipCounter.increment('embedding_empty_vector', {
            queryClass: input.queryPlan.queryClass,
            semanticQueryCount: input.semanticQueries.length,
          });
          bootstrapLogger.error(
            {
              queryClass: input.queryPlan.queryClass,
              semanticQueryCount: input.semanticQueries.length,
              embeddingModelId: this.embeddingModelId,
              reason: !primaryEmbedding ? 'embedding_undefined' : 'embedding_empty',
            },
            '[CandidatePool] Dense retrieval expected a non-empty embedding',
          );
          return {
            hits: [],
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
          profile.denseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits, degraded: false };
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
          degraded: true,
          degradation: {
            component: 'dense_semantic',
            severity: 'error',
            reason: denseErr instanceof Error ? denseErr.message : 'dense retrieval failed',
            fallbackApplied: 'sparse-only retrieval',
          },
        };
      }
    };

    const anchorTask = async (): Promise<AnchorResult> => {
      // T02-2: anchor similarity also uses an embedding (anchor.semanticSummary
      // → embed → denseSearch), so it's gated by the same kill switch.
      if (this.killSwitchDenseRetrieval) {
        return { hits: undefined };
      }
      if (!(activeChannels.has('anchor_similarity') && anchorProfile !== undefined)) {
        return { hits: undefined };
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
          profile.denseTopN,
          vespaRankProfile,
          requestId,
        );
        return { hits };
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
          hits: undefined,
          degradation: {
            component: 'anchor_similarity',
            severity: 'warning',
            reason: anchorErr instanceof Error ? anchorErr.message : 'anchor embedding failed',
            fallbackApplied: 'no-anchor retrieval',
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
      degraded: true,
      degradation: {
        component: 'sparse_bm25',
        severity: 'error',
        reason: 'sparse task threw uncaught error',
        fallbackApplied: 'empty sparse hits',
      },
    };
    const learnedSparseFallback: DenseLikeResult = {
      hits: [],
      degraded: false,
      degradation: {
        component: 'learned_sparse',
        severity: 'warning',
        reason: 'learned sparse task threw uncaught error',
        fallbackApplied: 'continue without learned sparse',
      },
    };
    const denseFallback: DenseLikeResult = {
      hits: [],
      degraded: true,
      degradation: {
        component: 'dense_semantic',
        severity: 'error',
        reason: 'dense task threw uncaught error',
        fallbackApplied: 'sparse-only retrieval',
      },
    };
    const anchorFallback: AnchorResult = {
      hits: undefined,
      degradation: {
        component: 'anchor_similarity',
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
    const learnedSparseResult = settle(settled[1], learnedSparseFallback, 'learned_sparse');
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
      }
    }

    const sparseHits = sparseResult.hits;
    const sparseDegraded = sparseResult.degraded;
    const learnedSparseHits = learnedSparseResult.hits;
    const denseHits = denseResult.hits;
    const denseDegraded = denseResult.degraded;
    const anchorHits = anchorResult.hits;

    // Step 4: Fuse via RRF
    // Per-class fusion config is a foundation module (Epic-16 / T16-2) that
    // was standalone before this wire-up. getFusionConfig falls back to
    // DEFAULT_FUSION_CONFIG (k=60) for unknown classes, so the change is
    // behavior-preserving for queries outside the 5 mapped classes. The
    // profile.fusionK still acts as the ultimate fallback when the mapped
    // class resolves to 'fallback' AND profile opts to a non-default k.
    const fusionQueryClass = mapDomainQueryClassToFusionQueryClass(input.queryPlan.queryClass, retrievalMode);
    const fusionConfig = getFusionConfig(fusionQueryClass);
    const effectiveFusionK = fusionConfig.rrfK;
    let candidates = this.fusionService.fuse(
      sparseHits,
      denseHits,
      anchorHits,
      effectiveFusionK,
      learnedSparseHits,
    );
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
    const sharedSemanticQueries: readonly string[] = [...input.semanticQueries];
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

    if (activeChannels.has('relative_filter') && input.anchorEntityId !== undefined) {
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
        this.degradationObserver?.onDegradation({
          component: 'relative_filter',
          severity: 'warning',
          reason: 'anchor entity not found in candidate pool or document store',
          fallbackApplied: 'unfiltered candidate list',
        });
      }
    }

    candidates = annotateCandidateConstraintEvidenceBatch(candidates, {
      hard: input.hardConstraints,
      soft: input.softConstraints,
      inferred: input.queryPlan.constraints.inferred,
    });

    // Step 5: Apply hard constraint filter (with drop log for E4 audit).
    const { filtered: hardFiltered, drops: hardFilterDrops } =
      this.constraintFilter.applyHardFiltersWithDropLog(candidates, input.hardConstraints);
    candidates = [...hardFiltered];
    this._lastDropLog = hardFilterDrops;
    const countAfterHardFilter = candidates.length;

    // Step 6: Structured assembly + protected recall.
    const envelopes = candidates.map((candidate) =>
      hybridCandidateToEnvelope(candidate, effectiveFusionK));
    const protectedCandidates = applyProtectedRecallPolicy(envelopes);
    const accumulated = accumulateEvidence(protectedCandidates);
    const assembled = this.candidateAssembler.assemble(
      accumulated.map((entry) => entry.mergedEnvelope),
      buildAssemblyPolicy(profile.finalTopK),
    );

    this._lastFusionTrace = {
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
          anchor: anchorHits?.length ?? 0,
        },
        afterFusion: countAfterFusion,
        afterHardFilter: countAfterHardFilter,
        afterAssembly: assembled.candidates.length,
      },
    };

    pipelineDebug(
      {
        step: 'retrieval.candidate_pool.assembled',
        query_class: input.queryPlan.queryClass,
        profile: profile.name,
        vespa_rank_profile: vespaRankProfile,
        sparse_hits: sparseHits.length,
        learned_sparse_hits: learnedSparseHits.length,
        dense_hits: denseHits.length,
        anchor_hits: anchorHits?.length ?? 0,
        skipped_phases: skippedPhases,
        final_candidates: assembled.candidates.length,
      },
      'pipeline candidate pool',
    );

    return assembled.candidates.map((candidate) => ({
      ...candidate.legacyCandidate,
      retrievalProvenance: candidate.provenance,
    }));
  }

  /**
   * @deprecated Use execute() for RetrievalExecutorV2 contract.
   */
  async generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
    return this.execute(input);
  }

  /**
   * E4: Returns the RRF fusion trace from the most recent execute() call.
   * Returns undefined before the first execute() call.
   * Mirrors the getLastFunnelMetrics() pattern on RankingPort.
   */
  getLastFusionTrace(): RrfFusionTrace | undefined {
    return this._lastFusionTrace;
  }

  /**
   * E4: Returns the hard-filter drop log from the most recent execute() call.
   * Empty array before the first execute() call or when no candidates were dropped.
   */
  getLastDropLog(): readonly CandidateDropRecord[] {
    return this._lastDropLog;
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

  private resolveRuntimeRetrievalMode(input: HybridRetrievalInput): string | undefined {
    // E2-U3: compiled-first — prefer compiledRetrievalMode from ExecutionContract
    const baseMode = input.compiledRetrievalMode ?? input.queryPlan.retrievalMode;
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

    for (const channel of profileChannels) {
      if (dispatchChannels.has(channel)) {
        active.add(channel);
        continue;
      }

      if (channel === 'learned_sparse' && dispatchChannels.has('sparse_bm25') && !this.killSwitchLearning) {
        active.add(channel);
        continue;
      }

      if (channel === 'relative_filter' && input.anchorEntityId !== undefined) {
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
        channel === 'anchor_similarity' ||
        channel === 'dense_semantic' ||
        channel === 'sparse_bm25'
      )) {
        active.add(channel);
        continue;
      }
    }

    if (active.size === 0) {
      active.add('sparse_bm25');
    }

    return active;
  }

  private shouldExecutePhase(
    phase: RetrievalPhase,
    activeChannels: ReadonlySet<CandidateChannel>,
  ): boolean {
    switch (phase) {
      case 'sparse':
        return activeChannels.has('sparse_bm25');
      case 'learned_sparse':
        return activeChannels.has('learned_sparse');
      case 'dense':
        return activeChannels.has('dense_semantic');
      case 'anchor_neighborhood':
        return activeChannels.has('anchor_similarity');
      case 'relative':
        return activeChannels.has('relative_filter');
    }
  }

  private async loadAnchorDocumentIfNeeded(
    input: HybridRetrievalInput,
    activeChannels: ReadonlySet<CandidateChannel>,
    runtimeMode?: string,
  ): Promise<RetrievalDocument | undefined> {
    const needsAnchorChannel =
      activeChannels.has('anchor_similarity') || activeChannels.has('relative_filter');
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

function toCandidateChannels(candidate: HybridCandidate): CandidateChannel[] {
  const channels: CandidateChannel[] = [];
  const seenChannels = new Set<CandidateChannel>();
  const pushChannel = (channel: CandidateChannel): void => {
    if (!seenChannels.has(channel)) {
      seenChannels.add(channel);
      channels.push(channel);
    }
  };
  if (candidate.sparseRank !== undefined) pushChannel('sparse_bm25');
  if (candidate.denseRank !== undefined) pushChannel('dense_semantic');
  if (candidate.learnedSparseRank !== undefined) pushChannel('learned_sparse');
  if (candidate.anchorRank !== undefined) pushChannel('anchor_similarity');

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

  // Bugbash 2026-04-09 (Group C): per-channel raw scores must NOT fall
  // back to retrievalFusionScore. That field is a fusion total (RRF) in
  // some code paths and a raw BM25 score in others, and substituting it
  // for a missing per-channel raw corrupts downstream LTR features.
  // Contract: when a per-channel rank is present but the matching raw is
  // missing, we log a warning and SKIP that channel entry rather than
  // fabricating an incorrect rawScore.
  if (candidate.sparseRank !== undefined) {
    if (candidate.sparseRawScore !== undefined) {
      channelScores.push({
        channel: 'sparse_bm25' as const,
        rawScore: candidate.sparseRawScore,
        rank: candidate.sparseRank,
        rrfContribution: rrfContribution(candidate.sparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: 'sparse_bm25',
          rank: candidate.sparseRank,
        },
        'hybridCandidateToEnvelope: sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.denseRank !== undefined) {
    if (candidate.denseRawScore !== undefined) {
      channelScores.push({
        channel: 'dense_semantic' as const,
        rawScore: candidate.denseRawScore,
        rank: candidate.denseRank,
        rrfContribution: rrfContribution(candidate.denseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: 'dense_semantic',
          rank: candidate.denseRank,
        },
        'hybridCandidateToEnvelope: dense channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.learnedSparseRank !== undefined) {
    if (candidate.learnedSparseRawScore !== undefined) {
      channelScores.push({
        channel: 'learned_sparse' as const,
        rawScore: candidate.learnedSparseRawScore,
        rank: candidate.learnedSparseRank,
        rrfContribution: rrfContribution(candidate.learnedSparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: 'learned_sparse',
          rank: candidate.learnedSparseRank,
        },
        'hybridCandidateToEnvelope: learned_sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.anchorRank !== undefined) {
    if (candidate.anchorRawScore !== undefined) {
      channelScores.push({
        channel: 'anchor_similarity' as const,
        rawScore: candidate.anchorRawScore,
        rank: candidate.anchorRank,
        rrfContribution: rrfContribution(candidate.anchorRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: 'anchor_similarity',
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
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- migration fallback
    fusionScore: candidate.fusionRrfTotal ?? candidate.retrievalFusionScore,
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
