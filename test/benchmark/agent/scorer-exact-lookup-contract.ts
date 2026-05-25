/**
 * Exact-lookup contract scoring.
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 8.2).
 * Produces the answerQuality multiplier (and the per-scenario
 * `exactLookupHit` / `failClosedAccuracy` metrics) for the four exact-lookup
 * match policies: `exact_entity`, `must_not_exact_match`,
 * `must_not_return_guarded_entity`, and `optional_alias_or_fail_closed`.
 *
 * The "forbidden-canonical-hit" predicate lives here because it is only used
 * by this scorer; the shared "canonical-includes-needle" predicate lives in
 * `scorer-exact-lookup-utils.ts` because it is also used by the
 * context-relevance / context-recall sites.
 */

import type { ScenarioExpectation } from './scenario.js';
import type { Diagnostic, ScenarioExecution } from './scorer.js';
import { isHonestNoEvidenceAbstentionScenario } from './scorer-abstention.js';
import { buildContextEvidenceRecords } from './scorer-evidence-utils.js';
import {
  buildExactLookupNeedles,
  collectObservedExactLookupValues,
  formatObservedExactLookupSummary,
  normalizeExactLookupSurface,
  observedCanonicalIncludesNeedle,
} from './scorer-exact-lookup-utils.js';

/**
 * Multiplier applied to answerQuality when the agent missed the expected
 * exact-entity surface. Soft penalty (0.35) — entity miss is a real
 * structural failure but not a critical-fail.
 */
const PENALTY_EXACT_LOOKUP_MISS = 0.35;

/**
 * Multiplier applied to answerQuality when a fail-closed contract is violated
 * (agent surfaced specific exact candidates for an ambiguous / guarded query
 * instead of refusing to answer). Same magnitude as the exact-lookup miss —
 * both are answerQuality structural failures, not critical-fails.
 */
const PENALTY_FAIL_CLOSED_VIOLATED = 0.35;

export interface ExactLookupScore {
  readonly exactLookupHit: number | null;
  readonly failClosedAccuracy: number | null;
  readonly multiplier: number;
}

function observedForbiddenCanonicalHit(
  canonicalLabels: readonly string[],
  forbiddenAlias: string,
  expectedNeedles: readonly string[],
  collapseWhitespace: boolean,
): boolean {
  const normalizedForbidden = normalizeExactLookupSurface(forbiddenAlias, collapseWhitespace);
  if (normalizedForbidden.length === 0) return false;
  return canonicalLabels.some((label) => {
    const normalizedLabel = normalizeExactLookupSurface(label, collapseWhitespace);
    if (!normalizedLabel.includes(normalizedForbidden)) {
      return false;
    }
    return !expectedNeedles.some((needle) => {
      const normalizedExpected = normalizeExactLookupSurface(needle, collapseWhitespace);
      return normalizedExpected.length > 0 && normalizedLabel.includes(normalizedExpected);
    });
  });
}

export function scoreExactLookupContract(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): ExactLookupScore {
  const exactLookup = exp.exactLookup;
  if (exactLookup === undefined) {
    return { exactLookupHit: null, failClosedAccuracy: null, multiplier: 1 };
  }
  if (isHonestNoEvidenceAbstentionScenario(exp, execution)) {
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'info',
      code: 'EXACT_LOOKUP_SKIPPED_NO_EVIDENCE_ABSTENTION',
      message: 'exact lookup contract not penalized: scenario explicitly allows honest abstention when retrieval returned no confirmable evidence',
    });
    return {
      exactLookupHit: null,
      failClosedAccuracy:
        exactLookup.matchPolicy === 'must_not_exact_match'
        || exactLookup.matchPolicy === 'optional_alias_or_fail_closed'
          ? 1
          : null,
      multiplier: 1,
    };
  }

  const records = buildContextEvidenceRecords(execution);
  const observed = collectObservedExactLookupValues(records);
  const hasAnyObservedExactCandidate = observed.entityIds.length > 0 || observed.canonicalLabels.length > 0;
  const collapseWhitespace = exactLookup.allowSpaceNormalization !== false;
  const expectedNeedles = buildExactLookupNeedles(exactLookup);
  const canonicalHit = expectedNeedles.some((needle) =>
    observedCanonicalIncludesNeedle(observed.canonicalLabels, needle, collapseWhitespace),
  );
  const entityHit = exactLookup.expectedEntityId !== undefined
    && exactLookup.expectedEntityId !== null
    && observed.entityIds.includes(exactLookup.expectedEntityId);
  const matchedExactEntity = entityHit || canonicalHit;

  const forbiddenEntityHit = (exactLookup.mustNotReturnEntityIds ?? []).find((entityId) =>
    observed.entityIds.includes(entityId),
  );
  const forbiddenExpectedNeedles =
    exactLookup.matchPolicy === 'exact_entity' ? expectedNeedles : [];
  const forbiddenCanonicalHit = (exactLookup.mustNotReturnCanonicalAliases ?? []).find((alias) =>
    observedForbiddenCanonicalHit(observed.canonicalLabels, alias, forbiddenExpectedNeedles, collapseWhitespace),
  );

  let multiplier = 1;
  let exactLookupHit: number | null = null;
  let failClosedAccuracy: number | null = null;

  if (exactLookup.matchPolicy === 'exact_entity') {
    exactLookupHit = matchedExactEntity ? 1 : 0;
    if (!matchedExactEntity) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'EXACT_LOOKUP_MISS',
        message: 'exact lookup contract missed the expected wine entity / canonical label',
        observed: formatObservedExactLookupSummary(observed),
        expected: expectedNeedles.join(' | '),
      });
      multiplier *= PENALTY_EXACT_LOOKUP_MISS;
    }
  } else if (exactLookup.matchPolicy === 'must_not_exact_match') {
    failClosedAccuracy = hasAnyObservedExactCandidate ? 0 : 1;
    if (hasAnyObservedExactCandidate) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'FAIL_CLOSED_EXACT_LOOKUP_VIOLATED',
        message: 'ambiguous / non-entity exact-lookup query returned specific exact candidates instead of failing closed',
        observed: formatObservedExactLookupSummary(observed),
      });
      multiplier *= PENALTY_FAIL_CLOSED_VIOLATED;
    }
  } else if (exactLookup.matchPolicy === 'must_not_return_guarded_entity') {
    const hasGuardedContract =
      (exactLookup.mustNotReturnEntityIds?.length ?? 0) > 0
      || (exactLookup.mustNotReturnCanonicalAliases?.length ?? 0) > 0;
    const guardedHit = forbiddenEntityHit !== undefined || forbiddenCanonicalHit !== undefined;
    failClosedAccuracy = guardedHit || (!hasGuardedContract && hasAnyObservedExactCandidate) ? 0 : 1;
    if (!hasGuardedContract && hasAnyObservedExactCandidate) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'FAIL_CLOSED_EXACT_LOOKUP_VIOLATED',
        message: 'ambiguous exact-lookup query has no guarded entity list and returned specific exact candidates',
        observed: formatObservedExactLookupSummary(observed),
      });
      multiplier *= PENALTY_FAIL_CLOSED_VIOLATED;
    }
  } else {
    if (matchedExactEntity) {
      exactLookupHit = 1;
      failClosedAccuracy = 1;
    } else if (!hasAnyObservedExactCandidate) {
      exactLookupHit = 0;
      failClosedAccuracy = 1;
    } else {
      exactLookupHit = 0;
      failClosedAccuracy = 0;
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'OPTIONAL_ALIAS_OR_FAIL_CLOSED_VIOLATED',
        message: 'policy-pending exact lookup neither matched the accepted alias target nor failed closed',
        observed: formatObservedExactLookupSummary(observed),
        expected: expectedNeedles.join(' | '),
      });
      multiplier *= PENALTY_FAIL_CLOSED_VIOLATED;
    }
  }

  if (forbiddenEntityHit !== undefined || forbiddenCanonicalHit !== undefined) {
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'warn',
      code: 'EXACT_LOOKUP_FORBIDDEN_MATCH',
      message: 'exact lookup returned a forbidden nearby entity / canonical label',
      observed: formatObservedExactLookupSummary(observed),
      expected: `${forbiddenEntityHit ?? ''}${forbiddenEntityHit !== undefined && forbiddenCanonicalHit !== undefined ? ' | ' : ''}${forbiddenCanonicalHit ?? ''}`,
    });
    multiplier *= PENALTY_FAIL_CLOSED_VIOLATED;
  }

  return {
    exactLookupHit,
    failClosedAccuracy,
    multiplier,
  };
}
