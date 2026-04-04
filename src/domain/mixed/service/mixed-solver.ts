import type { EntityId } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';
import type { Ranker } from '../../ranking/service/ranker.js';
import type { AnchorProfile } from '../model/anchor-profile.js';
import type { MixedQueryResult } from '../model/mixed-query-result.js';
import type { AnchorProfiler, AnchorEntityData } from './anchor-profiler.js';
import type { SimilarityScorer, SimilarityCandidate } from './similarity-scorer.js';
import type { ConstraintOverlay } from './constraint-overlay.js';

/**
 * Port for resolving an anchor entity from an entity ID.
 *
 * Infrastructure adapters implement this to look up entity data
 * from the entity store or enrichment service.
 */
export interface AnchorResolverPort {
  /**
   * Resolves an entity ID to its full attribute data.
   *
   * @param entityId - The entity to resolve.
   * @returns Entity data for anchor profiling, or undefined if not found.
   */
  resolve(entityId: EntityId): Promise<AnchorEntityData | undefined>;
}

/**
 * Port for retrieving candidates similar to an anchor entity.
 *
 * Infrastructure adapters implement this using nearest-neighbor search
 * or pre-computed similarity indices.
 */
export interface SimilarRetrievalPort {
  /**
   * Retrieves candidates similar to the given anchor profile.
   *
   * @param anchorProfile - The anchor entity profile.
   * @param limit - Maximum number of candidates to retrieve.
   * @returns Hybrid candidates ordered by retrieval-stage similarity.
   */
  retrieveSimilar(
    anchorProfile: AnchorProfile,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

/**
 * Port for retrieving candidate attribute data for constraint evaluation.
 */
export interface CandidateAttributePort {
  /**
   * Loads attribute data for a set of candidate entities.
   *
   * @param entityIds - The entities to load attributes for.
   * @returns Map from entity ID to attribute key-value pairs.
   */
  loadAttributes(
    entityIds: readonly EntityId[],
  ): Promise<ReadonlyMap<EntityId, Readonly<Record<string, unknown>>>>;

  /**
   * Loads similarity-relevant attributes for a candidate entity.
   *
   * @param entityId - The entity to load.
   * @returns Similarity candidate data, or undefined if not found.
   */
  loadSimilarityCandidate(
    entityId: EntityId,
  ): Promise<SimilarityCandidate | undefined>;
}

/**
 * Default number of similar candidates to retrieve from the index.
 */
const DEFAULT_RETRIEVAL_LIMIT = 100;

/**
 * Orchestrates the full mixed query flow (RFC-011).
 *
 * A mixed query is a "wines like X but ..." query that combines anchor
 * entity similarity with user-specified constraints. The pipeline:
 *
 * 1. Resolve anchor entity from the query plan's anchor candidates.
 * 2. Build an anchor profile from the resolved entity data.
 * 3. Retrieve candidates similar to the anchor.
 * 4. Rank with anchor-aware weights via the ranking pipeline.
 * 5. Apply constraint overlay (hard gates, exclude filters, soft adjustments).
 * 6. Compute anchor preservation rate for diagnostics.
 * 7. Return {@link MixedQueryResult}.
 *
 * The solver delegates resolution, retrieval, and ranking to ports and
 * services injected via constructor. It owns only the orchestration logic.
 */
export class MixedSolver {
  private readonly anchorResolver: AnchorResolverPort;
  private readonly anchorProfiler: AnchorProfiler;
  private readonly similarRetrieval: SimilarRetrievalPort;
  private readonly candidateAttributes: CandidateAttributePort;
  private readonly similarityScorer: SimilarityScorer;
  private readonly constraintOverlay: ConstraintOverlay;
  private readonly ranker: Ranker;
  private readonly retrievalLimit: number;

  constructor(
    anchorResolver: AnchorResolverPort,
    anchorProfiler: AnchorProfiler,
    similarRetrieval: SimilarRetrievalPort,
    candidateAttributes: CandidateAttributePort,
    similarityScorer: SimilarityScorer,
    constraintOverlay: ConstraintOverlay,
    ranker: Ranker,
    retrievalLimit?: number,
  ) {
    this.anchorResolver = anchorResolver;
    this.anchorProfiler = anchorProfiler;
    this.similarRetrieval = similarRetrieval;
    this.candidateAttributes = candidateAttributes;
    this.similarityScorer = similarityScorer;
    this.constraintOverlay = constraintOverlay;
    this.ranker = ranker;
    this.retrievalLimit = retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT;
  }

  /**
   * Executes the full mixed query pipeline.
   *
   * @param queryPlan - The query plan containing anchors, constraints, and class.
   * @returns The mixed query result with ranked wines and diagnostics.
   * @throws {Error} If the anchor entity cannot be resolved.
   */
  async solve(queryPlan: QueryPlanV1): Promise<MixedQueryResult> {
    // Step 1: Resolve anchor entity
    const anchorCandidate = queryPlan.anchors[0];
    if (anchorCandidate === undefined) {
      throw new Error(
        'MixedSolver requires at least one anchor candidate in the query plan',
      );
    }

    const anchorEntityId = anchorCandidate.candidateEntityIds[0];
    if (anchorEntityId === undefined) {
      throw new Error(
        'Anchor candidate has no entity IDs to resolve',
      );
    }

    const entityData = await this.anchorResolver.resolve(anchorEntityId);
    if (entityData === undefined) {
      throw new Error(
        `Failed to resolve anchor entity: ${String(anchorEntityId)}`,
      );
    }

    // Step 2: Build anchor profile
    const anchorProfile = this.anchorProfiler.buildProfile(
      entityData,
      anchorCandidate.confidence,
    );

    // Step 3: Retrieve candidates similar to anchor
    const candidates = await this.similarRetrieval.retrieveSimilar(
      anchorProfile,
      this.retrievalLimit,
    );

    // Step 4: Build the retrieval-layer anchor profile for the ranking pipeline
    const retrievalAnchorProfile = {
      semanticSummary: `${anchorProfile.canonicalLabel} ${anchorProfile.region} ${anchorProfile.style}`,
      embedding: anchorProfile.embedding,
      anchorConfidence: anchorProfile.anchorConfidence,
    };

    // Step 5: Rank with anchor-aware weights
    const rankedResults = await this.ranker.rank({
      queryPlan,
      candidates,
      anchorProfile: retrievalAnchorProfile,
      constraints: queryPlan.constraints,
    });

    // Step 6: Apply constraint overlay
    const entityIds = rankedResults.map((r) => r.entityId);
    const attrMap = await this.candidateAttributes.loadAttributes(entityIds);

    const overlayedResults = this.constraintOverlay.apply(
      rankedResults,
      queryPlan.constraints,
      attrMap,
    );

    // Step 7: Compute anchor preservation rate
    const preservationRate = await this.computePreservationRate(
      overlayedResults,
      anchorProfile,
    );

    return {
      anchor: anchorProfile,
      rankedResults: overlayedResults,
      constraintOverlay: queryPlan.constraints,
      anchorPreservationRate: preservationRate,
    };
  }

  /**
   * Computes what fraction of ranked results preserved core anchor
   * characteristics (region, grape overlap, style).
   *
   * A result is considered "preserved" if its anchor similarity score
   * exceeds a threshold (0.4).
   */
  private async computePreservationRate(
    results: readonly RankedResult[],
    anchorProfile: AnchorProfile,
  ): Promise<number> {
    if (results.length === 0) {
      return 0;
    }

    const PRESERVATION_THRESHOLD = 0.4;
    let preservedCount = 0;

    for (const result of results) {
      const candidate = await this.candidateAttributes.loadSimilarityCandidate(
        result.entityId,
      );
      if (candidate === undefined) {
        continue;
      }

      const similarity = this.similarityScorer.score(candidate, anchorProfile);
      if (similarity >= PRESERVATION_THRESHOLD) {
        preservedCount++;
      }
    }

    return preservedCount / results.length;
  }
}
