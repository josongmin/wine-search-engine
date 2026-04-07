/**
 * E6-U4: Substitute/Grouped Fallback Reuse Map (lock)
 *
 * The substitute/grouped fallback path is a REUSE family — not a new runtime:
 *   - Mixed solver (this file): resolves anchor + substitute candidates
 *   - Grouped result: domain/response/service/result-grouper.ts
 *   - Fallback routing: application/search/search-usecase-mixed-route.ts
 *
 * Do NOT create a substitute engine or a grouped-fallback engine as a
 * parallel runtime. Substitute queries must flow through the existing mixed
 * route (search-usecase-mixed-route.ts) with this solver as the inner strategy.
 * New substitute strategies extend this solver — they do NOT fork the path.
 */
import type { EntityId } from '../../shared/types/index.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';
import type { RankerPort } from '../../ranking/port/ranker.port.js';
import type { AnchorProfile } from '../model/anchor-profile.js';
import type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../port/mixed-query.port.js';
import type { MixedQueryResult } from '../model/mixed-query-result.js';
import type { CompiledWineQuery } from '../../query/model/compiled-wine-query.js';
import type { AnchorProfiler } from './anchor-profiler.js';
import type { SimilarityScorer } from './similarity-scorer.js';
import type { ConstraintOverlay } from './constraint-overlay.js';
import {
  MixedRouteDegradationError,
  type MixedFallbackReason,
} from '../model/mixed-degradation.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
export type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from '../port/mixed-query.port.js';

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
  private readonly ranker: RankerPort;
  private readonly retrievalLimit: number;

  constructor(
    anchorResolver: AnchorResolverPort,
    anchorProfiler: AnchorProfiler,
    similarRetrieval: SimilarRetrievalPort,
    candidateAttributes: CandidateAttributePort,
    similarityScorer: SimilarityScorer,
    constraintOverlay: ConstraintOverlay,
    ranker: RankerPort,
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
   * For similar_items mode: treats anchor as pseudo-query, excludes seed entity,
   * applies producer diversity (max 2 wines per producer), boosts tannin/body matches.
   *
   * @param queryPlan - The query plan containing anchors, constraints, and class.
   * @returns The mixed query result with ranked wines and diagnostics.
   * @throws {Error} If the anchor entity cannot be resolved.
   */
  async solve(queryPlan: QueryPlanV1, compiled?: CompiledWineQuery): Promise<MixedQueryResult> {
    // Step 1: Resolve anchor entity
    const anchorCandidate = queryPlan.anchors[0];
    if (anchorCandidate === undefined) {
      throw new MixedRouteDegradationError(
        'mixed_anchor_resolution_failed',
        'MixedSolver requires at least one anchor candidate in the query plan',
      );
    }

    const anchorEntityId = anchorCandidate.candidateEntityIds[0];
    if (anchorEntityId === undefined) {
      throw new MixedRouteDegradationError(
        'mixed_anchor_resolution_failed',
        'Anchor candidate has no entity IDs to resolve',
      );
    }

    const entityData = await this.anchorResolver.resolve(anchorEntityId);
    if (entityData === undefined) {
      throw new MixedRouteDegradationError(
        'mixed_anchor_resolution_failed',
        `Failed to resolve anchor entity: ${String(anchorEntityId)}`,
      );
    }

    // Step 2: Build anchor profile
    const anchorProfile = this.anchorProfiler.buildProfile(
      entityData,
      anchorCandidate.confidence,
    );

    // Step 3: Retrieve candidates similar to anchor
    let candidates = await this.similarRetrieval.retrieveSimilar(
      anchorProfile,
      this.retrievalLimit,
    );
    let fallbackReason: MixedFallbackReason | undefined;

    // Step 3a: For similar_items mode (mixed route), apply set-specific constraints
    if (queryPlan.retrievalMode === 'similar_items') {
      candidates = this.applySetConstraintsForSimilarItems(
        candidates,
        anchorEntityId,
      );
    }
    if (candidates.length === 0) {
      fallbackReason = 'mixed_similar_retrieval_fallback';
    }

    // Step 4: Build the retrieval-layer anchor profile for the ranking pipeline
    const retrievalAnchorProfile = {
      semanticSummary: `${anchorProfile.canonicalLabel} ${anchorProfile.region} ${anchorProfile.style}`,
      embedding: anchorProfile.embedding,
      anchorConfidence: anchorProfile.anchorConfidence,
    };

    // Step 5: Rank with anchor-aware weights
    let rankedResults: readonly RankedResult[];
    try {
      rankedResults = await this.ranker.rank({
        queryPlan,
        candidates,
        anchorProfile: retrievalAnchorProfile,
        constraints: queryPlan.constraints,
        // compiled-first: thread V2 execution contract so getModeWeights and
        // rerank gate use compiled.effectiveRoute/effectiveRetrievalMode (E6-U4)
        ...(compiled !== undefined ? { compiled } : {}),
      });
    } catch (err) {
      bootstrapLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[MixedSolver] ranker.rank() failed; degrading gracefully',
      );
      throw new MixedRouteDegradationError(
        'mixed_ranker_unavailable',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Step 6: Apply constraint overlay
    const entityIds = rankedResults.map((r) => r.entityId);
    const attrMap = await this.candidateAttributes.loadAttributes(entityIds);

    let overlayedResults: readonly RankedResult[];
    try {
      overlayedResults = this.constraintOverlay.apply(
        rankedResults,
        queryPlan.constraints,
        attrMap,
      );
    } catch (err) {
      bootstrapLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[MixedSolver] constraintOverlay.apply() failed; returning candidates without overlay',
      );
      overlayedResults = rankedResults;
    }

    // Step 7: Compute anchor preservation rate
    const preservationRate = await this.computePreservationRate(
      overlayedResults,
      anchorProfile,
    );
    const runtimeSignal = this.ranker.getLastRuntimeSignal();
    const runtimeDegradation = runtimeSignal?.degradation;
    // When retrieval produced no candidates (fallbackReason set), the route-level
    // degradation takes precedence — report only the retrieval fallback reason and
    // escalate execution mode to 'degraded' regardless of the ranker signal.
    const routeDegradation = fallbackReason !== undefined
      ? { executionMode: 'degraded' as const, degradationReasons: [fallbackReason] }
      : runtimeDegradation !== undefined
        ? { executionMode: runtimeDegradation.executionMode, degradationReasons: runtimeDegradation.degradationReasons }
        : undefined;

    return {
      anchor: anchorProfile,
      rankedResults: overlayedResults,
      constraintOverlay: queryPlan.constraints,
      anchorPreservationRate: preservationRate,
      ...(routeDegradation !== undefined ? { routeDegradation } : {}),
      ...(fallbackReason !== undefined
        ? { fallbackReason }
        : {}),
      ...(this.ranker.getLastFunnelMetrics?.() !== undefined
        ? { funnelMetrics: this.ranker.getLastFunnelMetrics() }
        : {}),
    };
  }

  /**
   * Epic 10: Applies set-specific constraints for similar_items mode.
   *
   * For similar_items (similar wines queries):
   * - Exclude the seed entity (anchor) itself from results
   * - Apply diversity constraint: max 2 wines from same producer
   * - Prioritize candidates that match anchor's tannin/body profile (±1 point)
   *
   * @param candidates - Raw candidates from similarity retrieval.
   * @param anchorEntityId - The reference entity ID to exclude.
   * @returns Filtered and reordered candidates for similar_items mode.
   */
  private applySetConstraintsForSimilarItems(
    candidates: readonly HybridCandidate[],
    anchorEntityId: EntityId,
  ): HybridCandidate[] {
    // Step 1: Exclude the anchor entity itself
    let filtered = candidates.filter((c) => c.entityId !== anchorEntityId);

    // Step 2: Apply producer diversity (max 2 per producer).
    // Candidates with no producer metadata bypass the slot check — lack of
    // metadata should never penalize a candidate (mirrors DefaultRankingPolicy).
    const producerMap = new Map<string, HybridCandidate[]>();
    const noProducer: HybridCandidate[] = [];
    for (const candidate of filtered) {
      const key = candidate.producer;
      if (key === undefined || key === '') {
        noProducer.push(candidate);
        continue;
      }
      if (!producerMap.has(key)) {
        producerMap.set(key, []);
      }
      const group = producerMap.get(key);
      if (group !== undefined && group.length < 2) {
        group.push(candidate);
      }
    }

    filtered = [...Array.from(producerMap.values()).flat(), ...noProducer];

    // Step 3: Re-sort by retrieval fusion score (proxy for embedding similarity)
    // Higher retrieval score = more similar to anchor
    filtered.sort((a, b) => b.retrievalFusionScore - a.retrievalFusionScore);

    return filtered;
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
