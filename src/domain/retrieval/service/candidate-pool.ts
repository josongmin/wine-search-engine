import type { SearchIndexPort, DenseHit } from '../port/search-index.port.js';
import type { EmbeddingServicePort } from '../port/embedding-service.port.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { RetrievalTrace } from '../model/retrieval-trace.js';
import { type FusionService } from './fusion.js';
import { RetrievalProfileService } from './retrieval-profile.js';
import { CascadeRouter, type RetrievalPhase } from './cascade-router.js';
import { ConstraintFilter } from './constraint-filter.js';
import { hardConstraintsToSparseFilterTokens } from './constraint-to-sparse-filter-tokens.js';
import { annotateCandidateConstraintEvidenceBatch } from './candidate-constraint-evidence.js';
import type { CacheService } from '../../performance/index.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

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
  }

  /**
   * Generate a ranked candidate pool from the hybrid retrieval pipeline.
   *
   * @param input - The retrieval input derived from the query plan.
   * @returns Fused, filtered, and ranked candidates.
   */
  async generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
    const profile = this.profileService.getProfile(
      input.queryPlan.queryClass,
      input.route,
    );

    const anchorConfidence = input.anchorProfile?.anchorConfidence ?? 0;
    const aliasMatchStrength = this.estimateAliasStrength(input);

    const difficulty = this.cascadeRouter.estimateDifficulty(
      input.queryPlan.queryClass,
      anchorConfidence,
      aliasMatchStrength,
      input.hardConstraints.length + input.softConstraints.length,
    );

    const phases = this.cascadeRouter.getPhases(difficulty);
    const phaseSet = new Set<RetrievalPhase>(phases);

    const allPhases: RetrievalPhase[] = ['sparse', 'dense', 'anchor_neighborhood', 'rerank'];
    const skippedPhases = allPhases.filter((p) => !phaseSet.has(p));

    // Vespa sparse filter tokens (aligned with browse/compare + buildSparseFilters)
    const filters = [...hardConstraintsToSparseFilterTokens(input.hardConstraints)];

    // Step 1: Sparse search
    const sparseHits = phaseSet.has('sparse')
      ? await this.searchIndex.sparseSearch(
          input.lexicalQueries,
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
        )
      : [];

    // Step 2: Dense search (with embedding cache via CacheService when wired)
    let denseHits: readonly DenseHit[] = [];
    if (phaseSet.has('dense') && input.semanticQueries.length > 0) {
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
    if (phaseSet.has('anchor_neighborhood') && input.anchorProfile) {
      const anchorEmbedding = input.anchorProfile.embedding
        ?? await this.embeddingService.embed(input.anchorProfile.semanticSummary);

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

    candidates = annotateCandidateConstraintEvidenceBatch(candidates, {
      hard: input.hardConstraints,
      soft: input.softConstraints,
      inferred: input.queryPlan.constraints.inferred,
    });

    // Step 5: Apply hard constraint filter
    candidates = [
      ...this.constraintFilter.applyHardFilters(candidates, input.hardConstraints),
    ];

    // Step 6: Return top-K
    return candidates.slice(0, profile.finalTopK);
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
}
