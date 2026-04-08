/**
 * Marketplace title contamination detector (RFC-002 §5.4).
 *
 * Detects whether a raw marketplace title has been semantically contaminated
 * by promotional language, unrelated product metadata, or retailer noise that
 * would corrupt canonical entity matching if ingested unchecked.
 *
 * The detector computes:
 *   1. **Token overlap** — Jaccard similarity between title tokens and
 *      canonical label tokens. Low overlap indicates the title has drifted
 *      from the entity it claims to represent.
 *   2. **Promotional density** — fraction of tokens that are known noise/
 *      promotional words. High density indicates marketing pollution.
 *   3. **Length anomaly** — titles far longer than the canonical label are
 *      likely padded with SEO keywords or product metadata.
 *
 * A contamination score in [0, 1] is returned: 0 = clean, 1 = fully
 * contaminated. Scores above {@link CONTAMINATION_THRESHOLD} should trigger
 * manual review or rejection of the ingestion candidate.
 */

/**
 * Maximum acceptable contamination score before the candidate is flagged.
 * Calibrated empirically on Bordeaux / Burgundy retail title noise.
 */
export const CONTAMINATION_THRESHOLD = 0.45;

/** Title token count vs canonical above this ratio counts as length padding. */
const TITLE_CANONICAL_LENGTH_ANOMALY_RATIO = 2.5;
/** Weight for Jaccard distance in composite contamination score. */
const CONTAMINATION_SCORE_WEIGHT_JACCARD = 0.5;
/** Weight for promotional token density. */
const CONTAMINATION_SCORE_WEIGHT_NOISE = 0.35;
/** Weight for title/label length anomaly. */
const CONTAMINATION_SCORE_WEIGHT_LENGTH = 0.15;

/**
 * Token words that are known marketplace noise — not part of any canonical
 * wine name and therefore count against the title's semantic quality.
 */
const NOISE_VOCABULARY = new Set([
  // English marketplace noise
  'ml', 'cl', 'l', 'bottle', 'bottles', 'pack', 'case', 'gift', 'box',
  'set', 'sale', 'offer', 'deal', 'buy', 'free', 'shipping', 'delivery',
  'new', 'hot', 'best', 'top', 'special', 'limited', 'edition', 'import',
  'imported', 'authentic', 'original', 'genuine', 'certified', 'award',
  'winning', 'gold', 'silver', 'medal', 'rated', 'points', 'score',
  'recommended', 'exclusive', 'available', 'stock', 'price', 'discount',
  'rebate', 'promo', 'promotion', 'coupon', 'bundle', 'combo', 'value',
  // Korean marketplace noise
  '선물', '세트', '박스', '배송', '무료', '특가', '할인', '프로모션',
  '정품', '수입', '인기', '추천', '베스트', '행사', '이벤트', '사은품',
  '사은', '증정', '구성', '패키지', '케이스', '병', '잔', '잔세트',
]);

/**
 * Result of the contamination detection analysis.
 */
export interface ContaminationResult {
  /**
   * Composite contamination score in [0, 1].
   * 0 = fully clean, 1 = fully contaminated.
   */
  readonly score: number;

  /**
   * Whether the score exceeds the {@link CONTAMINATION_THRESHOLD} and the
   * title should be flagged for manual review or rejected.
   */
  readonly flagged: boolean;

  /** Token Jaccard similarity between the title and canonical label. */
  readonly jaccardSimilarity: number;

  /** Fraction of title tokens classified as noise vocabulary. */
  readonly noiseDensity: number;

  /** Whether the title is anomalously long relative to the canonical label. */
  readonly lengthAnomaly: boolean;

  /** Noise tokens detected in the title. */
  readonly noiseTokensFound: readonly string[];
}

/**
 * Detects marketplace title contamination relative to a canonical entity label.
 *
 * This is a pure-computation, side-effect-free function. It operates on
 * pre-normalized (lowercased, whitespace-collapsed) strings.
 *
 * @param rawTitle - The marketplace product title (will be normalised internally).
 * @param canonicalLabel - The canonical entity label to compare against.
 * @returns A {@link ContaminationResult} describing the contamination level.
 */
export function detectContamination(
  rawTitle: string,
  canonicalLabel: string,
): ContaminationResult {
  const titleTokens = tokenize(rawTitle);
  const canonicalTokens = tokenize(canonicalLabel);

  // ── (1) Jaccard similarity ────────────────────────────────────────────────
  //
  // Measures how much vocabulary overlap exists between title and canonical
  // label. Wine names are specific; low overlap strongly suggests pollution.
  const titleSet = new Set(titleTokens);
  const canonicalSet = new Set(canonicalTokens);
  const intersection = new Set([...titleSet].filter((t) => canonicalSet.has(t)));
  const union = new Set([...titleSet, ...canonicalSet]);
  const jaccardSimilarity = union.size > 0 ? intersection.size / union.size : 1;

  // ── (2) Noise density ────────────────────────────────────────────────────
  //
  // Fraction of title tokens that are pure noise. A title like
  // "Château Margaux 750ml Gift Box Set Premium Sale" has 4 noise tokens
  // out of 8 → density = 0.5.
  const noiseTokensFound = titleTokens.filter((t) => NOISE_VOCABULARY.has(t));
  const noiseDensity =
    titleTokens.length > 0 ? noiseTokensFound.length / titleTokens.length : 0;

  // ── (3) Length anomaly ────────────────────────────────────────────────────
  //
  // If the title is more than 2.5× the length of the canonical label it is
  // likely padded with SEO/marketing text. Short canonical labels get a
  // generous multiplier to avoid false positives for brief wine names.
  const lengthRatio =
    canonicalTokens.length > 0
      ? titleTokens.length / canonicalTokens.length
      : 1;
  const lengthAnomaly = lengthRatio > TITLE_CANONICAL_LENGTH_ANOMALY_RATIO;

  // ── Composite score ────────────────────────────────────────────────────────
  //
  // Weighted combination:
  //   - Low Jaccard similarity contributes strongly (0.5 weight)
  //   - High noise density is a direct contamination signal (0.35 weight)
  //   - Length anomaly is a softer signal (0.15 weight)
  const jaccardPenalty = 1 - jaccardSimilarity;
  const score = Math.min(
    1,
    CONTAMINATION_SCORE_WEIGHT_JACCARD * jaccardPenalty +
    CONTAMINATION_SCORE_WEIGHT_NOISE * noiseDensity +
    CONTAMINATION_SCORE_WEIGHT_LENGTH * (lengthAnomaly ? 1 : 0),
  );

  return {
    score,
    flagged: score >= CONTAMINATION_THRESHOLD,
    jaccardSimilarity,
    noiseDensity,
    lengthAnomaly,
    noiseTokensFound,
  };
}

/**
 * Tokenises a string into normalised lowercase word tokens,
 * stripping punctuation and collapsing whitespace.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation, keep Unicode letters/numbers
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
