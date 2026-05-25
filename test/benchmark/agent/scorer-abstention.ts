/**
 * Honest-no-evidence abstention helpers.
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 8.2).
 * These three helpers are referenced by ≥5 scoring sites (exact-lookup contract,
 * answerQuality multiplier, context-relevance, context-recall) — keeping them
 * in a dedicated module avoids forcing each consumer to import all of scorer.ts.
 *
 * Single source of truth for:
 *   - the "[retrieval_quality: unreliable — 0 results]" sentinel detection
 *   - the (expectation × execution) → "honest abstention scenario" predicate
 *
 * Also re-exports `normalizeObservations` (the canonical observation-text join
 * used by every grounding / context check in scorer.ts).
 */

import type { ScenarioExpectation } from './scenario.js';
import type { ScenarioExecution } from './scorer.js';

/**
 * Single source of truth for joining observations into a searchable text block.
 *
 * Rules:
 *  - Separator is '\n' to preserve observation boundaries (a price at the end of
 *    obs N must not merge with text at the start of obs N+1).
 *  - NFKC normalization for consistent Korean/Unicode matching.
 *  - toLowerCase() for case-insensitive substring searches.
 *
 * ALL scorer functions that search observation text MUST call this helper instead
 * of rolling their own join logic.
 */
export function normalizeObservations(observations: readonly string[]): string {
  return observations.join('\n').toLowerCase().normalize('NFKC');
}

/**
 * Whether `observations` contain any of the retrieval-quality sentinels that
 * mean "the agent honestly reported zero / unreliable evidence". These tokens
 * are emitted by the tool layer when retrieval returned nothing actionable.
 */
export function hasExplicitNoEvidenceObservation(observations: readonly string[]): boolean {
  const normalized = normalizeObservations(observations);
  return normalized.includes('[retrieval_quality: unreliable — 0 results]')
    || normalized.includes('[retrieval_quality: unreliable - 0 results]')
    || normalized.includes('[retrieval_quality: corpus_limited')
    || normalized.includes('resolution_not_confirmed')
    || normalized.includes('검색 결과가 없습니다')
    || normalized.includes('데이터베이스에 매우 적습니다');
}

/**
 * A scenario qualifies as "honest no-evidence abstention" when:
 *   - the expectation explicitly allows it (`allowHonestNoEvidenceAbstention`)
 *   - AND the execution surfaced one of the retrieval-quality sentinels above
 *
 * Used by exact-lookup, answerQuality, context-relevance, and context-recall
 * scoring sites to skip / soften penalties when the agent correctly refused
 * to fabricate an answer for a corpus-limited query.
 */
export function isHonestNoEvidenceAbstentionScenario(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
): boolean {
  return exp.allowHonestNoEvidenceAbstention === true
    && hasExplicitNoEvidenceObservation(execution.observations);
}
