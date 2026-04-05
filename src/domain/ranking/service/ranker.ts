import type { EntityId } from '../../shared/types/index.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, ComponentScores } from '../model/ranked-result.js';
import type { RerankerPort, RerankCandidate } from '../port/reranker.port.js';
import { resolveWeights } from '../model/scoring-weights.js';
import { type SignalComputer } from './signal-computer.js';
import { type ScoreAggregator } from './score-aggregator.js';
import { type EvidenceMapper } from './evidence-mapper.js';

/**
 * Default number of top candidates to submit for cross-encoder reranking.
 */
const DEFAULT_RERANK_TOP_K = 20;

/**
 * Minimum candidate count to justify the cost of cross-encoder reranking.
 */
const RERANK_THRESHOLD = 5;

/**
 * Internal intermediate representation during ranking.
 */
interface ScoredEntry {
  readonly entityId: EntityId;
  readonly canonicalLabel: string;
  readonly componentScores: ComponentScores;
  readonly finalScore: number;
}

/**
 * Main ranking orchestrator (RFC-013).
 *
 * Pipeline:
 * 1. Compute all signal scores for each candidate via {@link SignalComputer}.
 * 2. Select scoring weights based on query class.
 * 3. Aggregate signals into final scores via {@link ScoreAggregator}.
 * 4. Filter out gated candidates (hard constraint / integrity failures).
 * 5. Sort by final score descending.
 * 6. Optionally rerank top-K via cross-encoder ({@link RerankerPort}).
 * 7. Map component scores to evidence items via {@link EvidenceMapper}.
 * 8. Return ordered {@link RankedResult}[].
 *
 * IMPORTANT: The ranker is a signal producer/aggregator. The final binding
 * decision is made by the Decision Layer (RFC-007). The `finalScore` in
 * ranked results is NOT a calibrated confidence C.
 */
export class Ranker {
  private readonly signalComputer: SignalComputer;
  private readonly scoreAggregator: ScoreAggregator;
  private readonly evidenceMapper: EvidenceMapper;
  private readonly reranker: RerankerPort | undefined;
  private readonly rerankTopK: number;

  /**
   * @param signalComputer - Computes individual signal scores.
   * @param scoreAggregator - Aggregates signals into final scores.
   * @param evidenceMapper - Maps component scores to evidence items.
   * @param reranker - Optional pluggable cross-encoder reranker.
   * @param rerankTopK - Number of top candidates to rerank (default: 20).
   */
  constructor(
    signalComputer: SignalComputer,
    scoreAggregator: ScoreAggregator,
    evidenceMapper: EvidenceMapper,
    reranker?: RerankerPort,
    rerankTopK?: number,
  ) {
    this.signalComputer = signalComputer;
    this.scoreAggregator = scoreAggregator;
    this.evidenceMapper = evidenceMapper;
    this.reranker = reranker;
    this.rerankTopK = rerankTopK ?? DEFAULT_RERANK_TOP_K;
  }

  /**
   * Ranks candidates according to the scoring formula and returns
   * ordered results with evidence trails.
   *
   * @param input - The ranking input containing query plan, candidates, constraints.
   * @returns Ranked results sorted by final score descending.
   */
  async rank(input: RankingInput): Promise<readonly RankedResult[]> {
    const { queryPlan, candidates, anchorProfile, constraints } = input;

    // Step 1: Compute all signals for each candidate
    const scored: ScoredEntry[] = [];

    // Step 2: Select weights based on query class
    const weights = resolveWeights(queryPlan.queryClass);

    for (const candidate of candidates) {
      const componentScores = this.signalComputer.computeAll(
        candidate,
        queryPlan,
        constraints,
        anchorProfile,
      );

      // Step 3: Aggregate signals into final score
      const finalScore = this.scoreAggregator.aggregate(
        componentScores,
        weights,
      );

      scored.push({
        entityId: candidate.entityId,
        canonicalLabel: candidate.canonicalLabel ?? '',
        componentScores,
        finalScore,
      });
    }

    // Step 4: Filter out -Infinity scores (hard constraint / integrity failures)
    const viable = scored.filter(
      (entry) => Number.isFinite(entry.finalScore),
    );

    // Step 5: Sort by finalScore descending
    viable.sort((a, b) => b.finalScore - a.finalScore);

    // Step 6: Optionally rerank top-K via cross-encoder
    let finalOrder: readonly ScoredEntry[] = viable;
    if (
      this.reranker !== undefined &&
      viable.length > RERANK_THRESHOLD
    ) {
      finalOrder = await this.applyReranking(
        queryPlan.normalizedQuery,
        viable,
      );
    }

    // Step 7 & 8: Map to RankedResult with evidence items and assign ranks
    const results: RankedResult[] = finalOrder.map((entry, index) => {
      const evidenceItems = this.evidenceMapper.mapToEvidence(
        entry.componentScores,
      );

      return {
        entityId: entry.entityId,
        canonicalLabel: entry.canonicalLabel,
        finalScore: entry.finalScore,
        rank: index + 1,
        componentScores: entry.componentScores,
        evidenceItems,
      };
    });

    return results;
  }

  /**
   * Applies cross-encoder reranking to the top-K candidates.
   *
   * Candidates beyond top-K retain their original order appended after
   * the reranked set. The final score is a blend of the cross-encoder
   * score and the original aggregated score.
   */
  private async applyReranking(
    query: string,
    viable: readonly ScoredEntry[],
  ): Promise<readonly ScoredEntry[]> {
    const topK = viable.slice(0, this.rerankTopK);
    const rest = viable.slice(this.rerankTopK);

    // Build rerank candidates — use entityId as text placeholder.
    // In production, infrastructure would enrich with entity descriptions.
    const rerankCandidates: RerankCandidate[] = topK.map((entry) => ({
      entityId: entry.entityId,
      text: String(entry.entityId),
    }));

    const rerankResults = await this.reranker!.rerank(
      query,
      rerankCandidates,
      this.rerankTopK,
    );

    // Build lookups
    const rerankScoreMap = new Map(
      rerankResults.map((r) => [String(r.entityId), r.score]),
    );
    const entryMap = new Map(
      topK.map((entry) => [String(entry.entityId), entry]),
    );

    // Reorder top-K by rerank score, blending with original score
    const rerankedTopK: ScoredEntry[] = [];

    for (const r of rerankResults) {
      const original = entryMap.get(String(r.entityId));
      if (original === undefined) {
        continue;
      }
      // Blend: 60% rerank score + 40% original score
      const blendedScore = 0.6 * r.score + 0.4 * original.finalScore;
      rerankedTopK.push({
        ...original,
        finalScore: blendedScore,
      });
    }

    // Add any topK entries that the reranker dropped
    for (const entry of topK) {
      if (!rerankScoreMap.has(String(entry.entityId))) {
        rerankedTopK.push(entry);
      }
    }

    // Sort reranked portion by blended score
    rerankedTopK.sort((a, b) => b.finalScore - a.finalScore);

    // Append the rest (unchanged)
    return [...rerankedTopK, ...rest];
  }
}
