/**
 * Answer-quality dimension scoring (heuristic contract checks).
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type { ScenarioExpectation } from './scenario.js';
import type { Diagnostic } from './scorer.js';
import { clamp01 } from './scorer-aggregation.js';

/** Answer quality: 50% penalty per regex miss in answerMustMatch. */
const PENALTY_REGEX_MISS = 0.5;
/**
 * Answer quality: 50% penalty per answerMustNotMatch hit (v4 rebalanced from 0.20).
 * Non-fatal — judge can partially offset.
 */
const PENALTY_MUST_NOT_MATCH = 0.50;

export function scoreAnswerQuality(
  exp: ScenarioExpectation,
  answer: string,
  diagnostics: Diagnostic[],
  judgeScore?: number,
): number {
  if (answer.trim().length === 0) {
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'critical',
      code: 'EMPTY_ANSWER',
      message: 'empty answer',
    });
    return 0;
  }

  const normalize = (s: string): string =>
    s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const normalizedAnswer = normalize(answer);

  let score = 1;

  // Observability: emit a diagnostic when the scenario has NO heuristic quality
  // constraints AND no LLM judge. In that case, answerQuality defaults to 1.0
  // regardless of what the agent said — which masks incomplete scenario specifications.
  // The diagnostic does NOT change the score; fixing requires adding constraints
  // or judgeRequired=true to the scenario.
  const hasHeuristicConstraints =
    (exp.answerContains !== undefined && exp.answerContains.length > 0) ||
    (exp.answerMustMatch !== undefined && exp.answerMustMatch.length > 0) ||
    (exp.answerExcludes !== undefined && exp.answerExcludes.length > 0) ||
    (exp.answerMustNotMatch !== undefined && exp.answerMustNotMatch.length > 0) ||
    exp.refusalExpected === true ||
    exp.requireHedging === true ||
    exp.requiredRegister !== undefined ||
    exp.maxConfidence !== undefined ||
    exp.mustCiteFromToolResults === true ||
    exp.priceBandKrw !== undefined ||
    exp.vintageRange !== undefined ||
    exp.drinkingWindowStatus !== undefined;

  if (!hasHeuristicConstraints && judgeScore === undefined) {
    diagnostics.push({
      dim: 'answerQuality',
      severity: 'warn',
      code: 'NO_QUALITY_CONSTRAINTS',
      message: 'scenario has no heuristic answer constraints and no judge score; answerQuality defaults to 1.0 — add answerContains/answerMustMatch/rubric+judgeRequired to constrain this dimension',
    });
  }

  if (exp.answerContains !== undefined && exp.answerContains.length > 0) {
    const matched = exp.answerContains.filter((kw) => normalizedAnswer.includes(normalize(kw)));
    const ratio = matched.length / exp.answerContains.length;
    if (ratio < 1) {
      const missing = exp.answerContains.filter((kw) => !normalizedAnswer.includes(normalize(kw)));
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'ANSWER_CONTAINS_MISSING',
        message: `answerContains missing: ${missing.join(', ')}`,
      });
    }
    score *= ratio;
  }

  if (exp.answerExcludes !== undefined && exp.answerExcludes.length > 0) {
    const violated = exp.answerExcludes.filter((kw) => normalizedAnswer.includes(normalize(kw)));
    if (violated.length > 0) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'critical',
        code: 'ANSWER_EXCLUDES_VIOLATED',
        message: `answerExcludes violated: ${violated.join(', ')}`,
      });
      return 0;
    }
  }

  // answerMustMatch: regex array, all must hit
  if (exp.answerMustMatch !== undefined && exp.answerMustMatch.length > 0) {
    for (const pattern of exp.answerMustMatch) {
      let re: RegExp;
      try { re = new RegExp(pattern, 'iu'); } catch {
        // A broken required-match regex silently passes scenarios that should fail.
        // Treat as critical to force scenario authors to fix broken patterns.
        diagnostics.push({ dim: 'answerQuality', severity: 'critical', code: 'INVALID_REGEX', message: `invalid regex in answerMustMatch: ${pattern}` });
        continue;
      }
      if (!re.test(answer)) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'ANSWER_MUST_MATCH_MISS',
          message: `regex did not match: ${pattern}`,
        });
        score *= PENALTY_REGEX_MISS;
      }
    }
  }

  // answerMustNotMatch: regex array, none may hit.
  //
  // SOTA++ v3 structural fix: downgraded from critical (immediate return 0) to
  // a strong multiplicative penalty. The previous hard-return 0 bypassed judge
  // scoring entirely, meaning `judgeRequired: true` scenarios with a matching
  // pattern could never be rescued by the judge even when the answer was
  // substantively correct (e.g. "죄송합니다만, 추천드리겠습니다" — polite preamble
  // before a valid recommendation). The judge now runs regardless, so a high
  // judge score can partially offset a heuristic-triggered penalty.
  //
  // Severity is 'warn' (not 'critical') so it does NOT trigger the
  // criticalFailure short-circuit that collapses overall to 0.
  // The penalty (PENALTY_MUST_NOT_MATCH) is 0.50 — strong enough to flag a
  // genuine refusal but not so extreme that a polite preamble annihilates a
  // correct recommendation.
  if (exp.answerMustNotMatch !== undefined && exp.answerMustNotMatch.length > 0) {
    for (const pattern of exp.answerMustNotMatch) {
      let re: RegExp;
      try { re = new RegExp(pattern, 'iu'); } catch {
        // An invalid answerMustNotMatch regex means the forbidden-content check
        // cannot run — this is a critical scenario authoring error (security gap),
        // not a graceful miss. Fail the scenario hard so the author is forced to fix it.
        diagnostics.push({ dim: 'answerQuality', severity: 'critical', code: 'INVALID_REGEX', message: `invalid regex in answerMustNotMatch: ${pattern}` });
        continue;
      }
      if (re.test(answer)) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'ANSWER_MUST_NOT_MATCH_HIT',
          message: `forbidden pattern matched: ${pattern}`,
        });
        score *= PENALTY_MUST_NOT_MATCH;
      }
    }
  }

  // v4: length-based bonus/penalty removed. scoreAnswerQuality is now purely contract-based.
  // See ANSWER_LENGTH_BONUS removal comment above for rationale.

  return clamp01(score);
}
