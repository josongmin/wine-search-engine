/**
 * Pure diff computation for ShadowModeRunner.
 *
 * This module exports two pure functions:
 *  - {@link tokenizeAnswerForSimilarity} — NFKC-lowercase, strip punctuation,
 *    tokenize on whitespace + Hangul character bigrams. Exposed for tests.
 *  - {@link computeAnswerSimilarity} — token-set Jaccard between two answers.
 *  - {@link computeShadowModeDiff} — the top-level diff used by the runner.
 *
 * Design choices:
 *
 *  1. Token-set Jaccard was picked over LCS / edit distance because:
 *     - Order-independent (so two orchestrators arriving at the same answer
 *       via different sentence orderings score 1.0).
 *     - Cheap O(n + m) to compute; LCS is O(n*m).
 *     - For Korean we also emit character bigrams of any Hangul run so that
 *       morphological variation ("추천해드립니다" vs "추천드립니다") still
 *       overlaps strongly. CLAUDE.md rule 5 / rule 8 — `\b` is ASCII-only,
 *       so we use `[\p{L}\p{N}]` boundaries with the `/u` flag.
 *
 *  2. `answerEquivalent` is `similarity ≥ THRESHOLD` OR "both empty/aborted"
 *     (both sides genuinely produced no answer — that is parity, not
 *     divergence).
 *
 *  3. `divergent` is true if ANY of: answer dissimilar, tool set differs,
 *     termination reason differs, or exactly one side errored. Tool-order
 *     differences alone do NOT mark divergent (the new orchestrator legitimately
 *     reorders parallel batches).
 */

import type {
  ShadowModeDiff,
  ShadowModeDivergentReason,
  ShadowModeOrchestratorOutcome,
} from './shadow-mode-schemas.js';
import {
  SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD,
  SHADOW_MODE_MAX_DIVERGENT_REASONS,
} from './shadow-mode-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Minimum length of a Hangul run before bigram expansion fires. Below this
 *  the run itself is already short enough to act as a single token. */
const HANGUL_BIGRAM_MIN_RUN_LENGTH = 2;

/** Identical answers (and both-empty) yield perfect similarity. */
const SIMILARITY_PERFECT = 1;

/** Disjoint or one-empty token sets yield zero similarity. */
const SIMILARITY_NONE = 0;

/**
 * Statuses that signal "this orchestrator produced no usable answer". Used to
 * decide whether an empty-answer pair represents parity (both sides
 * legitimately produced nothing) or a degenerate state.
 */
const EMPTY_ANSWER_STATUSES = new Set<ShadowModeOrchestratorOutcome['status']>([
  'aborted',
  'timeout',
]);

/**
 * Unicode-safe non-word-character regex used for stripping punctuation /
 * separators before whitespace tokenization. CLAUDE.md rule 8/24:
 *  - `\b` is ASCII-only — do not use.
 *  - `[\p{L}\p{N}]` is the character class — letters OR digits.
 *  - `\p{L}\p{N}` (without brackets) is a sequence and silently fails.
 *  - `/u` flag is required for `\p{...}`.
 */
const NON_WORD_CHAR = /[^\p{L}\p{N}]+/gu;

/** Detect a run of Hangul syllables (precomposed Unicode block AC00–D7AF). */
const HANGUL_RUN = /[\u{AC00}-\u{D7AF}]{2,}/gu;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * NFKC-lowercase, strip punctuation, tokenize on whitespace, expand Hangul
 * runs into character bigrams.
 *
 * Returns an empty set for empty / whitespace-only input.
 */
export function tokenizeAnswerForSimilarity(input: string): ReadonlySet<string> {
  if (input.length === 0) {
    return new Set();
  }
  const normalized = input.normalize('NFKC').toLowerCase();
  // Replace non-word chars with single space, then split.
  const whitespaceTokens = normalized
    .replace(NON_WORD_CHAR, ' ')
    .split(' ')
    .filter((tok) => tok.length > 0);

  const tokens = new Set<string>(whitespaceTokens);

  // Add Hangul bigrams from any run ≥ HANGUL_BIGRAM_MIN_RUN_LENGTH.
  // (We do not include the bigrams of non-Hangul runs because Latin words
  // typically already tokenize cleanly on whitespace.)
  for (const match of normalized.matchAll(HANGUL_RUN)) {
    const run = match[0];
    if (run.length < HANGUL_BIGRAM_MIN_RUN_LENGTH) {
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * Token-set Jaccard similarity in `[0, 1]`. Two empty answers yield
 * {@link SIMILARITY_PERFECT}; exactly one empty yields {@link SIMILARITY_NONE}.
 */
export function computeAnswerSimilarity(a: string, b: string): number {
  const aTokens = tokenizeAnswerForSimilarity(a);
  const bTokens = tokenizeAnswerForSimilarity(b);
  if (aTokens.size === 0 && bTokens.size === 0) {
    return SIMILARITY_PERFECT;
  }
  if (aTokens.size === 0 || bTokens.size === 0) {
    return SIMILARITY_NONE;
  }
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }
  const unionSize = aTokens.size + bTokens.size - intersection;
  if (unionSize <= 0) {
    return SIMILARITY_NONE;
  }
  return intersection / unionSize;
}

/**
 * True when the two orchestrators called exactly the same multiset of tool
 * names. Order independent.
 */
export function toolSetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // Compare as sorted arrays — handles duplicates correctly (multiset
  // equality). CLAUDE.md rule: explicit comparator on .sort().
  const aSorted = [...a].sort((x, y) => x.localeCompare(y));
  const bSorted = [...b].sort((x, y) => x.localeCompare(y));
  for (let i = 0; i < aSorted.length; i += 1) {
    if (aSorted[i] !== bSorted[i]) {
      return false;
    }
  }
  return true;
}

/** Strict element-wise equality of two tool-name arrays. */
export function toolOrderEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Diff entrypoint — pure, deterministic, no I/O. */
export function computeShadowModeDiff(
  legacy: ShadowModeOrchestratorOutcome,
  wineSearch: ShadowModeOrchestratorOutcome,
): ShadowModeDiff {
  const legacyAnswer = legacy.answer ?? '';
  const wineSearchAnswer = wineSearch.answer ?? '';
  const similarity = computeAnswerSimilarity(legacyAnswer, wineSearchAnswer);

  const bothLegitimatelyEmpty =
    legacyAnswer.length === 0
    && wineSearchAnswer.length === 0
    && EMPTY_ANSWER_STATUSES.has(legacy.status)
    && EMPTY_ANSWER_STATUSES.has(wineSearch.status);

  const answerEquivalent =
    bothLegitimatelyEmpty || similarity >= SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD;

  const setEqual = toolSetsEqual(legacy.toolNames, wineSearch.toolNames);
  const orderEqual = setEqual && toolOrderEqual(legacy.toolNames, wineSearch.toolNames);

  const terminationReasonEqual = legacy.terminationReason === wineSearch.terminationReason;

  const durationDeltaMs = wineSearch.totalDurationMs - legacy.totalDurationMs;
  const tokenDeltaInput = wineSearch.tokenUsage.inputTokens - legacy.tokenUsage.inputTokens;
  const tokenDeltaOutput = wineSearch.tokenUsage.outputTokens - legacy.tokenUsage.outputTokens;

  // "one side errored" means: exactly one orchestrator reached the 'ok'
  // status while the other did not (error / timeout / aborted are all
  // non-ok). When both succeed or both fail, neither side errored "uniquely".
  const legacyOk = legacy.status === 'ok';
  const wineSearchOk = wineSearch.status === 'ok';
  const oneSideErrored = legacyOk !== wineSearchOk;

  const reasons: ShadowModeDivergentReason[] = [];
  if (!answerEquivalent) reasons.push('answer_dissimilar');
  if (!setEqual) reasons.push('tool_set_diff');
  else if (!orderEqual) reasons.push('tool_order_diff');
  if (!terminationReasonEqual) reasons.push('termination_reason_diff');
  if (oneSideErrored) reasons.push('one_side_errored');

  // Cap to schema bound (defensive — current enum has 5 members so we never
  // exceed SHADOW_MODE_MAX_DIVERGENT_REASONS, but the slice keeps us safe if
  // future reasons are added without bumping the cap).
  const cappedReasons = reasons.slice(0, SHADOW_MODE_MAX_DIVERGENT_REASONS);

  // Tool-order diff alone is NOT a divergence (parallel batch reordering is
  // expected behavior for the new orchestrator). All other reasons do count.
  const divergent =
    !answerEquivalent
    || !setEqual
    || !terminationReasonEqual
    || oneSideErrored;

  return {
    answerEquivalent,
    answerSimilarity: similarity,
    toolSetEqual: setEqual,
    toolOrderEqual: orderEqual,
    terminationReasonEqual,
    durationDeltaMs,
    tokenDeltaInput,
    tokenDeltaOutput,
    divergent,
    divergentReasons: cappedReasons,
  };
}
