/**
 * Entity Lookup V2 — calibrated abstain decision authority (T-ELV2-05).
 *
 * The resolver's status is ADVISORY (see {@link EntityResolveResult}). The V2
 * stack owns its OWN terminal decision and is precision-first: it would rather
 * return `ambiguous`/`failed` than a wrong-positive `resolved` (RFC §4.4,
 * DoD §1 — `opu one`류 must NOT wrong-resolve).
 *
 * Design: **downgrade-only**. We take the resolver's calibrated trace as a
 * strong prior and apply guards that can only make the outcome MORE
 * conservative (resolved → ambiguous → failed), never less. This guarantees
 * the V2 decision can never introduce a wrong-positive that the resolver did
 * not already allow, while still tightening precision on:
 *   1. low calibrated confidence (below the class resolve threshold),
 *   2. a runner-up too close to call (top1-top2 margin below the gap threshold),
 *   3. UNtrusted calibration — a raw score must not be treated as a probability
 *      (memory: calibration-trust gate / RFC-016 §3); only an exact-evidence
 *      ceiling may certify a resolve when calibration params are not fresh.
 */

import type { EntityResolveResult } from '../model/resolve-result.js';
import type { QueryClass } from '../../shared/types/index.js';
import type { LookupDecision } from './lookup-v2-types.js';

/**
 * Calibrated-score ceiling that counts as exact-identity evidence even when the
 * calibration parameters are not trusted. At/above this the score reflects a
 * deterministic exact-alias match, not a learned probability, so it may certify
 * a resolve under untrusted calibration; below it, an untrusted score cannot.
 * 0.99 mirrors the resolver's exact-match signal ceiling.
 */
export const LOOKUP_EXACT_EVIDENCE_CEILING = 0.99;

export class CalibratedAbstainDecider {
  /**
   * Decide the terminal V2 status from the resolver result. Never upgrades the
   * resolver's advisory status; only holds or tightens it.
   */
  decide(result: EntityResolveResult, _queryClass: QueryClass): LookupDecision {
    const trace = result.decisionTrace;
    const topConfidence = clamp01(trace.top1CalibratedScore);
    const margin = trace.calibratedGap;
    const calibrationTrusted = trace.calibrationTrusted;

    // No candidates → unambiguously a non-match.
    if (result.candidates.length === 0) {
      return decision('failed', 'no_match', 'No candidate matched the query.', topConfidence, margin, calibrationTrusted);
    }

    // The resolver already abstained — honour it (downgrade-only never upgrades).
    if (result.status === 'failed') {
      return decision('failed', firstReason(trace.outcomeReasonCodes, 'low_confidence'), 'The resolver did not produce a confident match.', topConfidence, margin, calibrationTrusted);
    }
    if (result.status === 'ambiguous') {
      return decision('ambiguous', firstReason(trace.outcomeReasonCodes, 'ambiguous'), 'Multiple candidates remain plausible.', topConfidence, margin, calibrationTrusted);
    }

    // result.status === 'resolved' — apply precision-first guards (downgrade-only).
    const { resolveThreshold, gapThreshold } = trace.appliedThresholds;

    if (!calibrationTrusted) {
      // A raw, uncalibrated score must not be read as a probability. Only an
      // exact-evidence ceiling may certify a resolve here; otherwise abstain.
      if (topConfidence >= LOOKUP_EXACT_EVIDENCE_CEILING && isMarginClear(margin, gapThreshold)) {
        return decision('resolved', 'exact_identity_uncalibrated', 'Resolved on exact-identity evidence (calibration untrusted).', topConfidence, margin, calibrationTrusted);
      }
      return decision('ambiguous', 'uncalibrated_low_trust', 'Calibration is untrusted and evidence is not exact — abstaining.', topConfidence, margin, calibrationTrusted);
    }

    // Trusted calibration: enforce confidence floor + margin.
    if (topConfidence < resolveThreshold) {
      return decision('failed', 'below_resolve_threshold', 'Top candidate confidence is below the resolve threshold.', topConfidence, margin, calibrationTrusted);
    }
    if (!isMarginClear(margin, gapThreshold)) {
      return decision('ambiguous', 'narrow_margin', 'Top two candidates are too close to call.', topConfidence, margin, calibrationTrusted);
    }

    return decision('resolved', firstReason(trace.outcomeReasonCodes, 'calibrated_resolve'), 'Confidently resolved to a single entity.', topConfidence, margin, calibrationTrusted);
  }
}

/** A margin is "clear" when there is no runner-up, or the gap meets the threshold. */
function isMarginClear(margin: number | undefined, gapThreshold: number): boolean {
  return margin === undefined || margin >= gapThreshold;
}

function firstReason(codes: readonly string[], fallback: string): string {
  return codes[0] ?? fallback;
}

function decision(
  status: LookupDecision['status'],
  reasonCode: string,
  detail: string,
  topConfidence: number,
  margin: number | undefined,
  calibrationTrusted: boolean,
): LookupDecision {
  return {
    status,
    reasonCode,
    detail,
    topConfidence,
    ...(margin !== undefined ? { top1Top2Margin: clamp01(margin) } : {}),
    calibrationTrusted,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}
