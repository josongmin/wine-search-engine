/**
 * Query difficulty estimator.
 *
 * Epic-16 / T16-4 foundation: produce a deterministic prior on how hard
 * a query will be for the retrieval stack. Downstream components (top-K
 * selector, cascade router, budget allocator) consume the difficulty
 * label and score to pick recall width and latency budgets.
 *
 * Pure function, no I/O. All thresholds are named module-scope constants
 * annotated with the heuristic they encode. These priors will be
 * replaced by learned signals once sweep data is available.
 */

import { clamp01 } from '../../shared/utils/clamp.js';

type QueryDifficulty = 'easy' | 'medium' | 'hard';

interface DifficultyEstimate {
  readonly difficulty: QueryDifficulty;
  readonly score: number; // [0,1], 0=easy, 1=hard
  readonly signals: {
    readonly tokenCount: number;
    readonly hasAnchor: boolean;
    readonly anchorConfidence: number;
    readonly hasNumericConstraint: boolean;
    readonly hasNegation: boolean;
    readonly languageMix: 'monolingual' | 'mixed';
  };
}

export interface DifficultyInput {
  readonly normalizedQuery: string;
  readonly tokenCount: number;
  readonly hasAnchor: boolean;
  readonly anchorConfidence: number;
  readonly hasNumericConstraint: boolean;
  readonly hasNegation: boolean;
}

/**
 * Anchor confidence at/above this threshold makes the query trivially
 * easy — we have a near-certain entity match. Calibrated against the
 * resolver's self-reported confidence distribution.
 */
const EASY_ANCHOR_CONFIDENCE = 0.9;

/** Short queries (1-2 tokens) with no constraints are easy lookups. */
const EASY_TOKEN_COUNT_MAX = 2;

/**
 * Queries above this token count are in the "long tail" range where
 * retrieval recall starts to degrade without wider candidate pools.
 */
const HARD_TOKEN_COUNT_MIN = 6;

/** Hangul syllables block — primary Korean character range. */
const HANGUL_SYLLABLES_START = 0xac00;
const HANGUL_SYLLABLES_END = 0xd7a3;

/** Basic Latin letter ranges (upper + lower). */
const LATIN_UPPER_START = 0x0041;
const LATIN_UPPER_END = 0x005a;
const LATIN_LOWER_START = 0x0061;
const LATIN_LOWER_END = 0x007a;

// --- Score component weights (sum to 1.0) ---
// These encode how much each signal pushes the 0..1 difficulty score.
// The hard-rule branches below short-circuit to 0 or 1, so these
// weights only matter for the medium band.
const SCORE_WEIGHT_TOKEN_COUNT = 0.3;
const SCORE_WEIGHT_ANCHOR = 0.3;
const SCORE_WEIGHT_NEGATION = 0.15;
const SCORE_WEIGHT_NUMERIC = 0.1;
const SCORE_WEIGHT_LANGUAGE_MIX = 0.15;

/** Token count at which the token-count component saturates to 1.0. */
const TOKEN_COUNT_SATURATION = 10;

type LanguageMix = 'monolingual' | 'mixed';

function detectLanguageMix(query: string): LanguageMix {
  let hangul = 0;
  let latin = 0;
  for (const ch of query) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code >= HANGUL_SYLLABLES_START && code <= HANGUL_SYLLABLES_END) {
      hangul += 1;
    } else if (
      (code >= LATIN_UPPER_START && code <= LATIN_UPPER_END) ||
      (code >= LATIN_LOWER_START && code <= LATIN_LOWER_END)
    ) {
      latin += 1;
    }
  }
  return hangul > 0 && latin > 0 ? 'mixed' : 'monolingual';
}

// clamp01: imported from @domain/shared/utils/clamp (SSoT).

/**
 * Estimate query difficulty from deterministic priors.
 *
 * Hard-rule branches (short-circuit):
 *   - easy: anchorConfidence >= 0.9 OR (tokenCount in [1,2] AND no
 *     numeric constraint AND no negation)
 *   - hard: tokenCount >= 6 OR hasNegation OR (mixed language AND no
 *     anchor)
 *   - medium: everything else
 *
 * Score is a weighted combination of the signals, clamped to [0,1].
 */
export function estimateQueryDifficulty(
  input: DifficultyInput,
): DifficultyEstimate {
  const languageMix = detectLanguageMix(input.normalizedQuery);

  const signals = {
    tokenCount: input.tokenCount,
    hasAnchor: input.hasAnchor,
    anchorConfidence: input.anchorConfidence,
    hasNumericConstraint: input.hasNumericConstraint,
    hasNegation: input.hasNegation,
    languageMix,
  } as const;

  // --- Easy short-circuits ---
  const isShortClean =
    input.tokenCount >= 1 &&
    input.tokenCount <= EASY_TOKEN_COUNT_MAX &&
    !input.hasNumericConstraint &&
    !input.hasNegation;

  const isHighConfidenceAnchor =
    input.hasAnchor && input.anchorConfidence >= EASY_ANCHOR_CONFIDENCE;

  // Empty queries are "easy" in the sense that they bypass retrieval
  // width entirely — there's nothing to work with.
  const isEmpty = input.tokenCount === 0;

  if (isEmpty || isHighConfidenceAnchor || isShortClean) {
    return { difficulty: 'easy', score: 0, signals };
  }

  // --- Hard short-circuits ---
  const isLong = input.tokenCount >= HARD_TOKEN_COUNT_MIN;
  const isMixedUnanchored = languageMix === 'mixed' && !input.hasAnchor;

  if (isLong || input.hasNegation || isMixedUnanchored) {
    return { difficulty: 'hard', score: 1, signals };
  }

  // --- Medium: weighted score ---
  const tokenComponent = clamp01(input.tokenCount / TOKEN_COUNT_SATURATION);
  const anchorComponent = input.hasAnchor
    ? clamp01(1 - input.anchorConfidence)
    : 1;
  // Negation already short-circuits to 'hard' above (line 152), so by the
  // time we reach the medium-tier weighted score, hasNegation is always false.
  // The component is kept at 0 here so the weight semantics stay symmetric
  // with the other booleans (token / anchor / numeric / language).
  const negationComponent = 0;
  const numericComponent = input.hasNumericConstraint ? 1 : 0;
  const languageComponent = languageMix === 'mixed' ? 1 : 0;

  const score = clamp01(
    tokenComponent * SCORE_WEIGHT_TOKEN_COUNT +
      anchorComponent * SCORE_WEIGHT_ANCHOR +
      negationComponent * SCORE_WEIGHT_NEGATION +
      numericComponent * SCORE_WEIGHT_NUMERIC +
      languageComponent * SCORE_WEIGHT_LANGUAGE_MIX,
  );

  return { difficulty: 'medium', score, signals };
}
