import type { SearchIndexPort, DenseHit, SparseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type {
  CandidateEnvelope,
  CandidateChannel,
  QueryViewMatch,
} from '../model/candidate-envelope.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import {
  preferCanonicalRetrievalChannelLabel,
  preferCanonicalRetrievalChannelLabels,
} from '../model/retrieval-channel.js';
import { type FusionService } from './fusion.js';
import { RetrievalProfileService } from './retrieval-profile.js';
import { CascadeRouter, type RetrievalPhase } from './cascade-router.js';
import { ConstraintFilter } from './constraint-filter.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import { CandidateAssembler, type AssemblyPolicy } from './candidate-assembly.js';
import { applyProtectedRecallPolicy } from './protected-recall-policy.js';
import { accumulateEvidence } from './evidence-accumulator.js';
import { applyRelativeFilter } from './relative-filter-policy.js';
import type { CacheService } from '../../performance/index.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { pipelineDebug } from '../../../observability/request-pipeline-debug.js';
import { deriveQueryFamily } from '../../query/model/query-observability-vocab.js';

/** Default anchor confidence when plan omits explicit score (neutral). */
const HYBRID_ANCHOR_CONFIDENCE_DEFAULT = 0.5;
/** Max expansion terms fed into retrieval query views. */
const QUERY_EXPANSION_MAX_TERMS = 32;
/** Weight increment per repeated token occurrence in expansion stats. */
const QUERY_EXPANSION_TERM_WEIGHT_STEP = 0.25;

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
export class CandidatePoolService {
  private readonly profileService: RetrievalProfileService;
  private readonly cascadeRouter: CascadeRouter;
  private readonly constraintFilter: ConstraintFilter;
  private readonly candidateAssembler: CandidateAssembler;

  constructor(
    private readonly searchIndex: SearchIndexPort,
    private readonly embeddingService: EmbeddingServicePort,
    private readonly fusionService: FusionService,
    private readonly cacheService?: CacheService | undefined,
    private readonly embeddingModelId: string = 'bge-m3',
    private readonly killSwitchLearning: boolean = false,
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
  async generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
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
    const activeChannels = this.resolveActiveChannels(profile.channelMix, dispatchDecision, input);
    const allPhases: RetrievalPhase[] = [
      'sparse',
      'learned_sparse',
      'dense',
      'anchor_neighborhood',
      'relative',
      'rerank',
    ];
    const skippedPhases = allPhases.filter((phase) => !this.shouldExecutePhase(phase, activeChannels));

    // Vespa sparse filter tokens (aligned with browse/compare + buildSparseFilters)
    const filters = [...hardConstraintsToSparseFilterTokens(input.hardConstraints)];
    const anchorDocument = await this.loadAnchorDocumentIfNeeded(input, activeChannels);
    const anchorProfile = this.resolveAnchorProfile(input, anchorDocument);

    // Select Vespa rank profile based on retrieval mode.
    // Browse modes use prestige_hybrid to boost critic score + producer prestige
    // at the Vespa native-ranking stage, reducing post-retrieval re-ranking load.
    const vespaRankProfile = resolveVespaRankProfile(retrievalMode);

    // Step 1: Sparse search
    // Degrade to empty rather than crashing the pipeline — dense/anchor
    // channels may still return results for the query.
    let sparseHits: readonly SparseHit[] = [];
    let sparseDegraded = false;
    if (activeChannels.has('sparse_bm25')) {
      try {
        sparseHits = await this.searchIndex.sparseSearch(
          input.lexicalQueries,
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
          vespaRankProfile,
        );
      } catch (sparseErr) {
        bootstrapLogger.warn(
          {
            err: sparseErr,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Sparse search failed — degrading to dense-only retrieval',
        );
        sparseDegraded = true;
      }
    }

    // Step 1b: Learned sparse search
    let learnedSparseHits: readonly DenseHit[] = [];
    if (activeChannels.has('learned_sparse')) {
      try {
        learnedSparseHits = await this.searchIndex.searchLearnedSparse(
          buildLearnedSparseQueryWeights(input),
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
        );
      } catch (learnedErr) {
        bootstrapLogger.warn(
          {
            err: learnedErr,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Learned sparse search failed — continuing without learned sparse',
        );
      }
    }

    // Step 2: Dense search (with embedding cache via CacheService when wired)
    // Degrading to sparse-only (rather than throwing) when the embedding call
    // fails prevents a transient embedding service outage from blocking the
    // entire search. The sparse + learned sparse results are still returned;
    // the dense signal is simply absent for this request.
    let denseHits: readonly DenseHit[] = [];
    let denseDegraded = false;
    if (activeChannels.has('dense_semantic') && input.semanticQueries.length > 0) {
      try {
        const embeddings = this.cacheService
          ? await this.cacheService.getOrEmbedBatch(
              input.semanticQueries,
              this.embeddingModelId,
              this.embeddingService,
            )
          : await this.embeddingService.embedBatch(input.semanticQueries);

        const primaryEmbedding = embeddings[0];
        // Reject both undefined AND empty embeddings — an empty Float32Array
        // is truthy but produces nonsense ANN results / Vespa errors downstream.
        if (!primaryEmbedding || primaryEmbedding.length === 0) {
          bootstrapLogger.error(
            {
              queryClass: input.queryPlan.queryClass,
              semanticQueryCount: input.semanticQueries.length,
              embeddingModelId: this.embeddingModelId,
              reason: !primaryEmbedding ? 'embedding_undefined' : 'embedding_empty',
            },
            '[CandidatePool] Dense retrieval expected a non-empty embedding',
          );
          denseDegraded = true;
        } else {
          denseHits = await this.searchIndex.denseSearch(
            primaryEmbedding,
            filters.length > 0 ? filters : undefined,
            profile.denseTopN,
            vespaRankProfile,
          );
        }
      } catch (denseErr) {
        bootstrapLogger.warn(
          {
            err: denseErr,
            queryClass: input.queryPlan.queryClass,
            embeddingModelId: this.embeddingModelId,
          },
          '[CandidatePool] Dense retrieval failed — degrading to sparse-only retrieval',
        );
        denseDegraded = true;
      }
    }

    // Step 3: Anchor neighbourhood search
    // Degrading to no-anchor (rather than throwing) when the embedding call
    // fails prevents a transient embedding service outage from blocking the
    // entire search.  The sparse + dense results are still returned; the
    // neighbourhood signal is simply absent for this request.
    let anchorHits: readonly DenseHit[] | undefined;
    if (activeChannels.has('anchor_similarity') && anchorProfile !== undefined) {
      try {
        const anchorEmbedding = anchorProfile.embedding
          ?? await this.embeddingService.embed(anchorProfile.semanticSummary);

        anchorHits = await this.searchIndex.denseSearch(
          anchorEmbedding,
          filters.length > 0 ? filters : undefined,
          profile.denseTopN,
          vespaRankProfile,
        );
      } catch (anchorErr) {
        bootstrapLogger.warn(
          {
            err: anchorErr,
            anchorConfidence,
            queryClass: input.queryPlan.queryClass,
          },
          '[CandidatePool] Anchor embedding failed — degrading to no-anchor retrieval',
        );
        // anchorHits remains undefined; pipeline continues without anchor channel.
      }
    }

    // Step 4: Fuse via RRF
    let candidates = this.fusionService.fuse(
      sparseHits,
      denseHits,
      anchorHits,
      profile.fusionK,
      learnedSparseHits,
    );

    // Enrich traces with pipeline context
    const effectiveSkippedPhases = [
      ...skippedPhases,
      ...(sparseDegraded ? ['sparse' as RetrievalPhase] : []),
      ...(denseDegraded ? ['dense' as RetrievalPhase] : []),
    ];
    candidates = candidates.map((c) => ({
      ...c,
      retrievalTrace: {
        ...c.retrievalTrace,
        retrievalProfile: profile.name,
        lexicalQueriesUsed: [...input.lexicalQueries],
        semanticQueriesUsed: [...input.semanticQueries],
        filtersApplied: filters,
        skippedPhases: effectiveSkippedPhases,
      } satisfies RetrievalTrace,
    }));

    if (activeChannels.has('relative_filter') && input.anchorEntityId !== undefined) {
      candidates = applyRelativeFilter(candidates, {
        anchorEntityId: input.anchorEntityId,
        constraints: filters,
        ...(anchorDocument !== undefined ? { anchorDocument } : {}),
      });
    }

    candidates = annotateCandidateConstraintEvidenceBatch(candidates, {
      hard: input.hardConstraints,
      soft: input.softConstraints,
      inferred: input.queryPlan.constraints.inferred,
    });

    // Step 5: Apply hard constraint filter
    candidates = [
      ...this.constraintFilter.applyHardFilters(candidates, input.hardConstraints),
    ];

    // Step 6: Structured assembly + protected recall.
    const envelopes = candidates.map((candidate) =>
      hybridCandidateToEnvelope(candidate, profile.fusionK));
    const protectedCandidates = applyProtectedRecallPolicy(envelopes);
    const accumulated = accumulateEvidence(protectedCandidates);
    const assembled = this.candidateAssembler.assemble(
      accumulated.map((entry) => entry.mergedEnvelope),
      buildAssemblyPolicy(profile.finalTopK),
    );

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
    return baseMode;
  }

  private resolveActiveChannels(
    profileChannels: readonly CandidateChannel[],
    dispatchDecision: ReturnType<CascadeRouter['getDispatchDecision']>,
    input: HybridRetrievalInput,
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
      case 'rerank':
        return false;
    }
  }

  private async loadAnchorDocumentIfNeeded(
    input: HybridRetrievalInput,
    activeChannels: ReadonlySet<CandidateChannel>,
  ): Promise<RetrievalDocument | undefined> {
    if (
      input.anchorEntityId === undefined
      || (
        !activeChannels.has('anchor_similarity')
        && !activeChannels.has('relative_filter')
      )
    ) {
      return undefined;
    }

    const anchorDocument = await this.searchIndex.getDocument(input.anchorEntityId);
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
 * - everything else → `hybrid`: standard 50/50 BM25+ANN.
 */
function resolveVespaRankProfile(retrievalMode: string | undefined): string {
  switch (retrievalMode) {
    case 'producer_browse':
    case 'region_browse':
    case 'compare_candidates':
    case 'relative':
      return 'prestige_hybrid';
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

function reciprocalRankContribution(rank: number, fusionK: number): number {
  if (rank <= 0 || !Number.isFinite(rank)) return 0;
  return 1 / (fusionK + rank);
}

function toCandidateChannels(candidate: HybridCandidate): CandidateChannel[] {
  const channels: CandidateChannel[] = [];
  if (candidate.sparseRank !== undefined) channels.push('sparse_bm25');
  if (candidate.denseRank !== undefined) channels.push('dense_semantic');
  if (candidate.learnedSparseRank !== undefined) channels.push('learned_sparse');
  if (candidate.anchorRank !== undefined) channels.push('anchor_similarity');

  for (const source of candidate.retrievalTrace.candidateSources) {
    const canonicalSource = toCanonicalCandidateChannel(source);
    if (canonicalSource !== null && !channels.includes(canonicalSource)) {
      channels.push(canonicalSource);
    }
  }

  return channels;
}

function toCanonicalCandidateChannel(value: string): CandidateChannel | null {
  const canonical = preferCanonicalRetrievalChannelLabel(value);
  return isCandidateChannel(canonical) ? canonical : null;
}

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
  for (const channel of provenance.channels) {
    const canonical = toCanonicalCandidateChannel(channel);
    if (canonical !== null && !channels.includes(canonical)) {
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

function isCandidateChannel(value: string): value is CandidateChannel {
  switch (value) {
    case 'sparse_bm25':
    case 'dense_semantic':
    case 'learned_sparse':
    case 'anchor_similarity':
    case 'relative_filter':
    case 'browse_producer':
    case 'browse_region':
    case 'compare_anchor':
      return true;
    default:
      return false;
  }
}

function hybridCandidateToEnvelope(
  candidate: HybridCandidate,
  fusionK: number,
): CandidateEnvelope {
  if (candidate.retrievalProvenance !== undefined) {
    const provenance = normalizeCandidateProvenance(candidate.retrievalProvenance);
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

  if (candidate.sparseRank !== undefined) {
    channelScores.push({
      channel: 'sparse_bm25' as const,
      rawScore: candidate.retrievalFusionScore,
      rank: candidate.sparseRank,
      rrfContribution: reciprocalRankContribution(candidate.sparseRank, fusionK),
    });
  }
  if (candidate.denseRank !== undefined) {
    channelScores.push({
      channel: 'dense_semantic' as const,
      rawScore: candidate.retrievalFusionScore,
      rank: candidate.denseRank,
      rrfContribution: reciprocalRankContribution(candidate.denseRank, fusionK),
    });
  }
  if (candidate.learnedSparseRank !== undefined) {
    channelScores.push({
      channel: 'learned_sparse' as const,
      rawScore: candidate.retrievalFusionScore,
      rank: candidate.learnedSparseRank,
      rrfContribution: reciprocalRankContribution(candidate.learnedSparseRank, fusionK),
    });
  }
  if (candidate.anchorRank !== undefined) {
    channelScores.push({
      channel: 'anchor_similarity' as const,
      rawScore: candidate.retrievalFusionScore,
      rank: candidate.anchorRank,
      rrfContribution: reciprocalRankContribution(candidate.anchorRank, fusionK),
    });
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
    fusionScore: candidate.retrievalFusionScore,
  } satisfies CandidateEnvelope['provenance'];
  const normalizedProvenance = normalizeCandidateProvenance(provenance);

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
      counts.set(token, (counts.get(token) ?? 0) + Math.max(1, boost.weight));
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
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
