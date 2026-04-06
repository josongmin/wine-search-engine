import type { SearchIndexPort, DenseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { CandidateEnvelope, CandidateChannel } from '../model/candidate-envelope.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
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
import { deriveQueryFamily } from '../../query/model/query-observability-vocab.js';

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

    // Step 1: Sparse search
    const sparseHits = activeChannels.has('sparse_bm25')
      ? await this.searchIndex.sparseSearch(
          input.lexicalQueries,
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
        )
      : [];

    // Step 1b: Learned sparse search
    const learnedSparseHits = activeChannels.has('learned_sparse')
      ? await this.searchIndex.searchLearnedSparse(
          buildLearnedSparseQueryWeights(input),
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
        )
      : [];

    // Step 2: Dense search (with embedding cache via CacheService when wired)
    let denseHits: readonly DenseHit[] = [];
    if (activeChannels.has('dense_semantic') && input.semanticQueries.length > 0) {
      const embeddings = this.cacheService
        ? await this.cacheService.getOrEmbedBatch(
            input.semanticQueries,
            this.embeddingModelId,
            this.embeddingService,
          )
        : await this.embeddingService.embedBatch(input.semanticQueries);

      const primaryEmbedding = embeddings[0];
      if (!primaryEmbedding) {
        bootstrapLogger.error(
          {
            queryClass: input.queryPlan.queryClass,
            semanticQueryCount: input.semanticQueries.length,
            embeddingModelId: this.embeddingModelId,
          },
          '[CandidatePool] Dense retrieval expected an embedding but received none',
        );
        throw new Error('Dense retrieval failed: embedding service returned no primary embedding');
      }

      denseHits = await this.searchIndex.denseSearch(
        primaryEmbedding,
        filters.length > 0 ? filters : undefined,
        profile.denseTopN,
      );
    }

    // Step 3: Anchor neighbourhood search
    let anchorHits: readonly DenseHit[] | undefined;
    if (activeChannels.has('anchor_similarity') && anchorProfile !== undefined) {
      const anchorEmbedding = anchorProfile.embedding
        ?? await this.embeddingService.embed(anchorProfile.semanticSummary);

      anchorHits = await this.searchIndex.denseSearch(
        anchorEmbedding,
        filters.length > 0 ? filters : undefined,
        profile.denseTopN,
      );
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
    candidates = candidates.map((c) => ({
      ...c,
      retrievalTrace: {
        ...c.retrievalTrace,
        retrievalProfile: profile.name,
        lexicalQueriesUsed: [...input.lexicalQueries],
        semanticQueriesUsed: [...input.semanticQueries],
        filtersApplied: filters,
        skippedPhases,
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
    // Use the highest anchor confidence as a proxy for alias match strength
    return Math.max(...anchors.map((a) => a.confidence));
  }

  private resolveRuntimeRetrievalMode(input: HybridRetrievalInput): string | undefined {
    if (
      input.queryPlan.retrievalMode === 'compare_candidates'
      && input.anchorEntityId !== undefined
    ) {
      return 'relative';
    }
    return input.queryPlan.retrievalMode;
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

      if (channel === 'learned_sparse' && dispatchChannels.has('sparse_bm25')) {
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
      anchorConfidence: input.queryPlan.anchors[0]?.confidence ?? 0.5,
    };
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
  return 1 / (fusionK + rank);
}

function toCandidateChannels(candidate: HybridCandidate): CandidateChannel[] {
  const channels: CandidateChannel[] = [];
  if (candidate.sparseRank !== undefined) channels.push('sparse_bm25');
  if (candidate.denseRank !== undefined) channels.push('dense_semantic');
  if (candidate.learnedSparseRank !== undefined) channels.push('learned_sparse');
  if (candidate.anchorRank !== undefined) channels.push('anchor_similarity');
  return channels;
}

function hybridCandidateToEnvelope(
  candidate: HybridCandidate,
  fusionK: number,
): CandidateEnvelope {
  if (candidate.retrievalProvenance !== undefined) {
    return {
      entityId: candidate.entityId,
      provenance: candidate.retrievalProvenance,
      legacyCandidate: candidate,
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

  return {
    entityId: candidate.entityId,
    provenance,
    legacyCandidate: {
      ...candidate,
      retrievalProvenance: provenance,
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

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 32)
    .map(([token, count]) => ({
      token,
      weight: 1 + (count - 1) * 0.25,
    }));
}
