import type { EntityId, QueryClass } from '../../shared/types/index.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, ComponentScores } from '../model/ranked-result.js';
import type { RerankerPort, RerankCandidate } from '../port/reranker.port.js';
import type { WineAttributeEncoderPort } from '../port/wine-attribute-encoder.port.js';
import { resolveWeights } from '../model/scoring-weights.js';
import { effectiveRerankBlendWeight } from './rerank-blend.js';
import { type SignalComputer } from './signal-computer.js';
import { type ScoreAggregator } from './score-aggregator.js';
import { type EvidenceMapper } from './evidence-mapper.js';
import { WineAttributeEncoders } from './wine-attribute-encoder.js';

/**
 * Default number of top candidates to submit for cross-encoder reranking.
 */
const DEFAULT_RERANK_TOP_K = 20;

/** Max characters sent to the cross-encoder (latency + model context). */
const RERANK_PASSAGE_MAX_CHARS = 1200;

/**
 * Builds a wine-aware passage text for cross-encoder reranking (RFC-017 §5.2).
 */
function buildWineText(entry: ScoredEntry): string {
  const parts: string[] = [];
  const label = entry.canonicalLabel.trim();
  if (label.length > 0) parts.push(label);
  const prod = entry.producer?.trim();
  if (prod !== undefined && prod.length > 0) parts.push(prod);
  const reg = entry.region?.trim();
  if (reg !== undefined && reg.length > 0) parts.push(reg);
  const en = entry.searchTextEn?.trim();
  if (en !== undefined && en.length > 0) parts.push(en);
  const grape = entry.grapePrimary?.trim();
  if (grape !== undefined && grape.length > 0) parts.push(grape);

  if (parts.length === 0) return String(entry.entityId);

  let passage = parts.join('. ');
  if (passage.length > RERANK_PASSAGE_MAX_CHARS) {
    passage = passage.slice(0, RERANK_PASSAGE_MAX_CHARS);
  }
  return passage;
}

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
  readonly producer?: string;
  readonly region?: string;
  readonly searchTextEn?: string;
  readonly grapePrimary?: string;
  readonly appellation?: string;
  readonly producerPrestige?: number;
  readonly componentScores: ComponentScores;
  readonly finalScore: number;
  readonly drinkingWindowStart?: number | undefined;
  readonly drinkingWindowEnd?: number | undefined;
  readonly drinkingWindowModelVersion?: string | undefined;

  // Wine attributes for Epic 15 dynamic prediction
  readonly vintageYear?: number | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly criticScoreNormalized?: number | undefined;
  readonly grapePrimaryEnc?: number | undefined;
  readonly regionEnc?: number | undefined;
  readonly countryEnc?: number | undefined;
}

export type RankerOptions = {
  readonly rerankTopK?: number;
  readonly rerankBlendScale?: number;
  readonly rerankThreshold?: number;
  readonly attributeEncoder?: WineAttributeEncoderPort;
  readonly reranker?: RerankerPort;
};

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
  private readonly attributeEncoder: WineAttributeEncoderPort;
  private readonly rerankTopK: number;
  private readonly rerankBlendScale: number;
  private readonly rerankThreshold: number;

  /**
   * @param signalComputer - Computes individual signal scores.
   * @param scoreAggregator - Aggregates signals into final scores.
   * @param evidenceMapper - Maps component scores to evidence items.
   * @param options - Optional ranking capabilities and tuning knobs.
   */
  constructor(
    signalComputer: SignalComputer,
    scoreAggregator: ScoreAggregator,
    evidenceMapper: EvidenceMapper,
    options: RankerOptions = {},
  ) {
    this.signalComputer = signalComputer;
    this.scoreAggregator = scoreAggregator;
    this.evidenceMapper = evidenceMapper;
    this.reranker = options.reranker;
    this.attributeEncoder = options.attributeEncoder ?? WineAttributeEncoders;
    this.rerankTopK = options.rerankTopK ?? DEFAULT_RERANK_TOP_K;
    this.rerankBlendScale = options.rerankBlendScale ?? 1;
    this.rerankThreshold = options.rerankThreshold ?? RERANK_THRESHOLD;
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
        ...(candidate.producer !== undefined ? { producer: candidate.producer } : {}),
        ...(candidate.region !== undefined ? { region: candidate.region } : {}),
        ...(candidate.searchTextEn !== undefined
          ? { searchTextEn: candidate.searchTextEn }
          : {}),
        ...(candidate.grapePrimary !== undefined
          ? { grapePrimary: candidate.grapePrimary }
          : {}),
        ...(candidate.drinkingWindowStart !== undefined ? { drinkingWindowStart: candidate.drinkingWindowStart } : {}),
        ...(candidate.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: candidate.drinkingWindowEnd } : {}),
        ...(candidate.drinkingWindowModelVersion !== undefined
          ? { drinkingWindowModelVersion: candidate.drinkingWindowModelVersion }
          : {}),
        // Epic 15: Wine attributes with label encoding
        ...(candidate.vintageYear !== undefined ? { vintageYear: candidate.vintageYear } : {}),
        ...(candidate.body !== undefined ? { body: candidate.body } : {}),
        ...(candidate.tannin !== undefined ? { tannin: candidate.tannin } : {}),
        ...(candidate.acidity !== undefined ? { acidity: candidate.acidity } : {}),
        ...(candidate.sweetness !== undefined ? { sweetness: candidate.sweetness } : {}),
        ...(candidate.criticScoreNormalized !== undefined
          ? { criticScoreNormalized: candidate.criticScoreNormalized }
          : {}),
        // Encode categorical attributes
        ...(candidate.grapePrimary !== undefined
          ? { grapePrimaryEnc: this.attributeEncoder.encodeGrape(candidate.grapePrimary) }
          : {}),
        ...(candidate.appellation !== undefined
          ? { regionEnc: this.attributeEncoder.encodeRegion(candidate.appellation) }
          : {}),
        ...(candidate.country !== undefined
          ? { countryEnc: this.attributeEncoder.encodeCountry(candidate.country) }
          : {}),
        ...(candidate.appellation !== undefined ? { appellation: candidate.appellation } : {}),
        ...(candidate.producerPrestige !== undefined
          ? { producerPrestige: candidate.producerPrestige }
          : {}),
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
      viable.length > this.rerankThreshold
    ) {
      try {
        finalOrder = await this.applyReranking(
          queryPlan.normalizedQuery,
          viable,
          queryPlan.queryClass,
        );
      } catch {
        finalOrder = viable;
      }
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
        ...(entry.producer !== undefined ? { producer: entry.producer } : {}),
        ...(entry.region !== undefined ? { region: entry.region } : {}),
        ...(entry.grapePrimary !== undefined ? { grapePrimary: entry.grapePrimary } : {}),
        ...(entry.appellation !== undefined ? { appellation: entry.appellation } : {}),
        ...(entry.producerPrestige !== undefined ? { producerPrestige: entry.producerPrestige } : {}),
        ...(entry.drinkingWindowStart !== undefined ? { drinkingWindowStart: entry.drinkingWindowStart } : {}),
        ...(entry.drinkingWindowEnd !== undefined ? { drinkingWindowEnd: entry.drinkingWindowEnd } : {}),
        ...(entry.drinkingWindowModelVersion !== undefined
          ? { drinkingWindowModelVersion: entry.drinkingWindowModelVersion }
          : {}),
        // Epic 15: Wine attributes for dynamic prediction
        ...(entry.vintageYear !== undefined ? { vintage: entry.vintageYear } : {}),
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        ...(entry.tannin !== undefined ? { tannin: entry.tannin } : {}),
        ...(entry.acidity !== undefined ? { acidity: entry.acidity } : {}),
        ...(entry.sweetness !== undefined ? { sweetness: entry.sweetness } : {}),
        ...(entry.criticScoreNormalized !== undefined
          ? { avgCriticProxyScore: Math.round(80 + entry.criticScoreNormalized * 20) }
          : {}),
        ...(entry.grapePrimaryEnc !== undefined ? { grapePrimaryEnc: entry.grapePrimaryEnc } : {}),
        ...(entry.regionEnc !== undefined ? { regionEnc: entry.regionEnc } : {}),
        ...(entry.countryEnc !== undefined ? { countryEnc: entry.countryEnc } : {}),
      };
    });

    return results;
  }

  /**
   * Applies cross-encoder reranking to the top-K candidates.
   *
   * Candidates beyond top-K retain their original order appended after
   * the reranked set.  The final score blends the cross-encoder score with
   * the original aggregated score using a query-class-aware weight
   * (RFC-017 §5.3) rather than a hardcoded ratio.
   */
  private async applyReranking(
    query: string,
    viable: readonly ScoredEntry[],
    queryClass: QueryClass,
  ): Promise<readonly ScoredEntry[]> {
    const topK = viable.slice(0, this.rerankTopK);
    const rest = viable.slice(this.rerankTopK);

    // Build wine-aware passage text for the cross-encoder (RFC-017 §5.2).
    const rerankCandidates: RerankCandidate[] = topK.map((entry) => ({
      entityId: entry.entityId,
      text: buildWineText(entry),
    }));

    const reranker = this.reranker;
    if (reranker === undefined) {
      throw new Error('applyReranking requires reranker');
    }
    const rerankResults = await reranker.rerank(
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

    // Normalise reranker scores to [0, 1] before blending.
    // Cross-encoder logits (e.g. BGE-reranker) are typically in [-10, +15];
    // a sigmoid squashes them to a comparable [0, 1] range, and min-max
    // within the batch preserves the relative ordering while ensuring scale
    // compatibility with the original aggregated score (also [0, 1]).
    const rawScores = rerankResults.map((r) => r.score);
    const minRaw = Math.min(...rawScores);
    const maxRaw = Math.max(...rawScores);
    const rawRange = maxRaw - minRaw;

    function normalizeRerankScore(raw: number): number {
      if (rawRange < 1e-8) return 0.5; // all scores equal → neutral
      // Min-max within batch: maps to [0, 1] preserving relative order.
      // Sigmoid compression is unnecessary when min-max already bounds the range.
      return (raw - minRaw) / rawRange;
    }

    // Reorder top-K by rerank score, blending with original score
    const rerankedTopK: ScoredEntry[] = [];

    for (const r of rerankResults) {
      const original = entryMap.get(String(r.entityId));
      if (original === undefined) {
        continue;
      }
      // Blend: query-class weight × optional global scale (RFC-017 §5.3)
      const w = effectiveRerankBlendWeight(queryClass, this.rerankBlendScale);
      const normScore = normalizeRerankScore(r.score);
      const blendedScore = w * normScore + (1 - w) * original.finalScore;
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
