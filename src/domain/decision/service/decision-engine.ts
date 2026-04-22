/**
 * E3-U7: Decision-Engine No-Copy Rule.
 *
 * This file is the SINGLE authoritative decision engine. Any calibrator,
 * confidence scorer, or ranked-route policy MUST plug in via the ranked-route
 * insertion point (search-usecase-ranked-route-resolve.ts) — NOT by copying or
 * subclassing this engine. "Small decision coordinator" is not a valid reason
 * to create a parallel decision layer. See E3-U6 and E3-U7 unit cards.
 *
 * @see search-usecase-ranked-route-resolve.ts — single calibrator insertion point
 */
import type { DecisionStatus, NextAction, DecisionSnapshot } from '../../shared/types/index.js';
import { isCorruptedSnapshot } from '../../shared/types/index.js';
import { isLegacyRequireClarificationHardGate } from '../../query/model/query-policy.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type { ThresholdStore } from '../../query/port/threshold-store.port.js';
import type { ThresholdEntry } from '../../query/model/threshold-profile.js';
import {
  DEFAULT_THRESHOLD_PROFILE,
  computeDynamicGapThreshold,
  type NumericGateMode,
} from '../../query/model/threshold-profile.js';
import { hasExactMatchCandidate, type DecisionInput } from '../model/decision-input.js';
import type { DecisionOutput } from '../model/decision-output.js';
import type { DecisionTrace } from '../model/decision-trace.js';
import { EvidenceGate, type EvidenceGateResult } from './evidence-gate.js';
import { AdmissionGate } from './admission-gate.js';
import type { FailureReason } from '../model/failure-reason.js';
import { identityHash } from '../../shared/utils/hash.js';
import type { ConfidenceRefusalPolicy } from './confidence-refusal.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { buildAuthorityTraceRef } from './authority-trace.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';
import type { EvidenceItem } from '../../shared/types/evidence-item.js';

/**
 * Internal intermediate state used during decision processing.
 * Accumulates the rules applied and reasons to build the final trace.
 */
interface DecisionState {
  status: DecisionStatus;
  nextAction: NextAction;
  rulesApplied: string[];
  finalReason: string;
}

function requireDecisionEvidenceItems(input: DecisionInput): readonly EvidenceItem[] {
  if (input.evidenceItems === undefined) {
    globalSilentSkipCounter.increment('decision_evidence_items_absent', {
      queryClass: input.queryPlan.queryClass,
      route: input.queryPlan.route,
    });
    return [];
  }
  return input.evidenceItems;
}
const NOISY_SHORT_QUERY_MAX_COMPACT_LENGTH = 12;
const NOISY_SHORT_QUERY_CONFIDENCE_FLOOR = 0.9;
const NOISY_SHORT_QUERY_GAP_FLOOR = 0.08;

/** Decimal places for C/gap floats embedded in decision trace strings. */
const DECISION_TRACE_FLOAT_DECIMAL_PLACES = 4;

/**
 * Emergency fallback resolveTau used when a brand-new QueryClass enum value
 * was added without updating either the active threshold profile or the
 * default profile. Set conservatively HIGH so unknown classes err toward
 * "ambiguous" rather than wrong-resolve. Tune via the threshold profile,
 * not by changing this constant — this should rarely fire.
 */
const EMERGENCY_FALLBACK_RESOLVE_TAU = 0.85;
const EXPLORATORY_RETRIEVAL_MODES = new Set([
  'compare_candidates',
  'recommendation',
  'similar_items',
  'producer_browse',
  'region_browse',
]);

function isExploratoryRetrievalMode(mode: string | undefined): boolean {
  return mode !== undefined && EXPLORATORY_RETRIEVAL_MODES.has(mode);
}

function requireEffectiveRetrievalMode(input: DecisionInput): ExecutionRetrievalMode {
  if (input.effectiveRetrievalMode === undefined) {
    throw new Error('DecisionInput.effectiveRetrievalMode is required for compiled-only execution');
  }
  return input.effectiveRetrievalMode;
}

function requireEffectiveRoute(input: DecisionInput): QueryRoute {
  if (input.effectiveRoute === undefined) {
    throw new Error('DecisionInput.effectiveRoute is required for compiled-only execution');
  }
  return input.effectiveRoute;
}

/**
 * THE FINAL AUTHORITY — the Decision Engine, per RFC-007.
 *
 * This is the most critical code in the entire Wine Intelligence Engine.
 * It is the sole component that produces binding decision status and
 * next action values. No other component may override its output.
 *
 * ## Critical Rules
 *
 * 1. **Ranking score alone NEVER forces resolution.** Only calibrated
 *    decision confidence C may be compared against thresholds.
 * 2. **Raw score threshold is FORBIDDEN.** All numeric gates use only
 *    the calibrated C and calibrated gap (delta).
 * 3. **"fallback" is NEVER a decision_status value.** The only valid
 *    statuses are: `resolved`, `ambiguous`, `failed`.
 *
 * ## Decision Pipeline (RFC-007 §6)
 *
 * 1. Policy pre-processing (§6.3): short-circuit on policy overrides.
 * 2. Numeric gate (§6.2): threshold-based resolution logic.
 * 3. Evidence obligation (§4.1): downgrade if evidence is missing.
 * 4. Policy overlay: final adjustments from require_exact, allow_approximate, fallback_mode.
 * 5. Build trace: capture all inputs, signals, thresholds, versions, and rules.
 */
export class DecisionEngine {
  private readonly evidenceGate: EvidenceGate;
  private readonly admissionGate: AdmissionGate;

  /**
   * Creates a new DecisionEngine.
   *
   * @param thresholdStore - Store for threshold profiles used in numeric gates.
   * @param confidenceRefusalPolicy - Optional confidence refusal policy (Epic 17.3).
   *   If provided, enables confidence-based refusal in the AdmissionGate.
   *   If absent, confidence check is skipped (backward compatible).
   */
  constructor(
    private readonly thresholdStore: ThresholdStore,
    confidenceRefusalPolicy?: ConfidenceRefusalPolicy,
  ) {
    this.evidenceGate = new EvidenceGate();
    this.admissionGate = new AdmissionGate(confidenceRefusalPolicy);
  }

  /**
   * Makes the binding decision for a query resolution.
   *
   * doc_guard E3-U7: No-copy rule.
   * Decision objects returned by this method must NOT be cloned or mutated
   * downstream. Consumers receive a read-only view of the DecisionOutput;
   * pass the same reference forward. Creating a modified copy to adjust
   * decisionStatus, nextAction, or any trace field is forbidden — route
   * all post-decision logic through policy hooks wired before this call.
   *
   * @param input - Aggregated signals from all pipeline stages.
   * @param snapshot - System version snapshot at decision time.
   * @returns The binding decision output with full trace.
   */
  async decide(input: DecisionInput, snapshot: DecisionSnapshot): Promise<DecisionOutput> {
    // Guard: corrupted snapshots must not reach identity hash, snapshot_ref,
    // or admission gate logic — fail fast with a diagnostic trace.
    if (isCorruptedSnapshot(snapshot)) {
      bootstrapLogger.warn(
        '[DecisionEngine] Corrupted decision snapshot passed to decide(); failing decision',
      );
      const failedTrace: DecisionTrace = {
        decisionStatus: 'failed',
        nextAction: 'fail',
        inputs: {
          queryClass: input.queryPlan.queryClass,
          effectiveRoute: requireEffectiveRoute(input),
          effectiveRetrievalMode: requireEffectiveRetrievalMode(input),
          ...(input.retrievalKind !== undefined
            ? { retrievalKind: input.retrievalKind }
            : {}),
          policy: {
            requireExact: input.policy.requireExact,
            allowApproximate: input.policy.allowApproximate,
            clarificationBias: input.policy.clarificationBias,
            fallbackMode: input.policy.fallbackMode,
          },
        },
        signals: { decisionConfidence: 0, calibratedGap: undefined, ambiguity: false },
        thresholds: { resolveThreshold: 0, gapThreshold: 0, numericGateMode: 'strict' },
        versions: {
          plannerVersion: input.queryPlan.plannerVersion,
          policyRuleVersion: input.queryPlan.policyRuleVersion,
          thresholdProfileId: input.queryPlan.thresholdProfileId,
        },
        rulesApplied: ['CORRUPTED_SNAPSHOT_REJECTED'],
        finalReason: 'Decision rejected: corrupted decision snapshot (snapshot_id = __corrupted__).',
      };
      return {
        decisionStatus: 'failed',
        nextAction: 'fail',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        candidates: input.resolveResult.candidates,
        signalSet: input.rankingSignals ?? {
          entity_integrity_score: 0,
          hard_constraint_pass: 0,
          soft_constraint_score: 0,
          semantic_relevance_score: 0,
          preference_alignment_score: 0,
          popularity_score: 0,
          availability_score: 0,
          uncertainty_penalty: 0,
        },
        evidenceItems: requireDecisionEvidenceItems(input),
        decisionTraceRef: 'corrupted_snapshot',
        decisionSnapshot: snapshot,
        decisionTrace: failedTrace,
      };
    }
    const thresholds = await this.loadThresholds(input);
    const rulesApplied: string[] = [];

    // Compute dynamic gap threshold (RFC-009 §5.3)
    const C = input.resolveResult.decisionTrace.decisionConfidenceC;
    const dynamicGapThreshold = computeDynamicGapThreshold(input.queryPlan.queryClass, C);

    // ── Step 1: Policy pre-processing (RFC-007 §6.3) ───────────────
    const policyResult = this.applyPolicyPreprocessing(input, rulesApplied);
    if (policyResult !== null) {
      bootstrapLogger.info(
        {
          queryClass: input.queryPlan.queryClass,
          finalStatus: policyResult.status,
          finalReason: policyResult.finalReason,
          rulesApplied,
        },
        '[DecisionEngine] policy preprocessing early return',
      );
      return this.buildOutput(input, policyResult, thresholds, snapshot, rulesApplied, undefined, undefined, dynamicGapThreshold);
    }

    // ── Step 1.5: Apply clarificationBias to effective thresholds ──
    // Combine policy bias + uncertainty force_clarify into a single
    // threshold modifier. Both are soft signals, not hard gates.
    const UNCERTAINTY_FORCE_CLARIFY_BIAS = 0.10;
    const policyBias = input.policy.clarificationBias;
    const uncertaintyBias = input.uncertainty.decisionEffect === 'force_clarify'
      ? UNCERTAINTY_FORCE_CLARIFY_BIAS
      : 0;
    const clarificationBias = Math.max(policyBias, uncertaintyBias);
    const effectiveThresholds = clarificationBias > 0
      ? { resolveTau: thresholds.resolveTau + clarificationBias, gapTau: thresholds.gapTau }
      : thresholds;
    if (clarificationBias > 0) {
      rulesApplied.push(`CLARIFICATION_BIAS_${clarificationBias.toFixed(2)}`);
    }

    // ── Step 2: Numeric gate (RFC-007 §6.2) ────────────────────────
    const numericState = this.applyNumericGate(input, effectiveThresholds, rulesApplied);

    // ── Step 3: Evidence obligation (RFC-007 §4.1) ───���──────────────
    const afterEvidence = this.applyEvidenceObligation(input, numericState, rulesApplied);

    // ── Step 4: Policy overlay ─────────────────────────────────────
    const afterPolicy = this.applyPolicyOverlay(input, afterEvidence, rulesApplied);

    // ── Step 4.5: Noisy short-query guard ───────────────────────────
    const finalState = this.applyNoisyShortQueryGuard(
      input,
      afterPolicy,
      rulesApplied,
      dynamicGapThreshold,
    );

    // ── Step 5: AdmissionGate (RFC-016) ────────────────────────────
    // The gate is the final closure before a resolved status is emitted.
    // Non-resolved decisions bypass the gate so that clarification/failure
    // outcomes are never blocked.
    if (finalState.status === 'resolved') {
      const admissionResult = this.admissionGate.check(input, snapshot);
      if (!admissionResult.admitted) {
        bootstrapLogger.warn(
          {
            reason: admissionResult.reason,
            rulesApplied,
            queryClass: input.queryPlan.queryClass,
            C: input.resolveResult.decisionTrace.decisionConfidenceC,
          },
          '[DecisionEngine] ADMISSION_GATE_REJECTED',
        );
        rulesApplied.push('ADMISSION_GATE_REJECTED');
        rulesApplied.push(admissionResult.reason);
        const rejectedState: DecisionState = {
          status: 'failed',
          nextAction: 'fail',
          rulesApplied: [...rulesApplied],
          finalReason: `Admission gate rejected the resolved decision: ${admissionResult.reason}.`,
        };
        return this.buildOutput(
          input,
          rejectedState,
          thresholds,
          snapshot,
          rulesApplied,
          admissionResult.reason,
          admissionResult.traceRef,
          dynamicGapThreshold,
        );
      }
    }

    bootstrapLogger.info(
      {
        queryClass: input.queryPlan.queryClass,
        resolverStatus: input.resolveResult.status,
        finalStatus: finalState.status,
        finalReason: finalState.finalReason,
        rulesApplied,
        C: input.resolveResult.decisionTrace.decisionConfidenceC,
        gap: input.resolveResult.decisionTrace.calibratedGap,
        A: input.resolveResult.decisionTrace.ambiguityDetected,
        conformal: input.conformalSetSize,
        ltrSaturated: input.ltrSaturated,
        identityEvidencePresent: input.evidenceSummary?.identityEvidencePresent,
      },
      '[DecisionEngine] gate trace',
    );
    return this.buildOutput(input, finalState, thresholds, snapshot, rulesApplied, undefined, undefined, dynamicGapThreshold);
  }

  /**
   * Step 1: Policy pre-processing (§6.3).
   *
   * Short-circuits the decision when policy directives mandate a specific outcome:
   * - `require_clarification=true` → AMBIGUOUS immediately.
   * - Uncertainty `decisionEffect=force_clarify` → AMBIGUOUS immediately.
   * - Uncertainty `decisionEffect=block_resolve` → FAILED immediately.
   *
   * @returns A DecisionState if short-circuited, or null to continue.
   */
  private applyPolicyPreprocessing(
    input: DecisionInput,
    rulesApplied: string[],
  ): DecisionState | null {
    // require_clarification policy override (legacy hard gate)
    if (isLegacyRequireClarificationHardGate(input.policy)) {
      rulesApplied.push('POLICY_REQUIRE_CLARIFICATION');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: 'Policy requires clarification; decision short-circuited to AMBIGUOUS.',
      };
    }

    // Uncertainty-driven overrides.
    // SOTA++ change: force_clarify is no longer a hard gate. High-severity
    // ambiguity from the planner often reflects candidate pool composition
    // (107 hybrid results) rather than genuine query uncertainty. Convert
    // to a threshold bias so overwhelming evidence can still resolve.
    if (input.uncertainty.decisionEffect === 'force_clarify') {
      rulesApplied.push('UNCERTAINTY_FORCE_CLARIFY_AS_BIAS');
      // Additional bias on top of clarificationBias from policy compiler.
      // Not a short-circuit — falls through to numeric gate with raised bar.
    }

    if (input.uncertainty.decisionEffect === 'block_resolve') {
      rulesApplied.push('UNCERTAINTY_BLOCK_RESOLVE');
      return {
        status: 'failed',
        nextAction: 'fail',
        rulesApplied: [...rulesApplied],
        finalReason: 'Uncertainty assessment blocks resolution; decision short-circuited to FAILED.',
      };
    }

    // Ambiguity summary override
    if (input.ambiguitySummary?.decisionEffect === 'force_clarify') {
      rulesApplied.push('AMBIGUITY_FORCE_CLARIFY');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: 'Ambiguity summary forces clarification; decision short-circuited to AMBIGUOUS.',
      };
    }

    if (input.ambiguitySummary?.decisionEffect === 'block_resolve') {
      rulesApplied.push('AMBIGUITY_BLOCK_RESOLVE');
      return {
        status: 'failed',
        nextAction: 'fail',
        rulesApplied: [...rulesApplied],
        finalReason: 'Ambiguity summary blocks resolution; decision short-circuited to FAILED.',
      };
    }

    return null;
  }

  /**
   * Step 2: Numeric gate (§6.2).
   *
   * Uses ONLY calibrated decision confidence C and calibrated gap (delta).
   * Raw scores and ranking scores are NEVER used for threshold comparison.
   *
   * Gap threshold is DYNAMIC (RFC-009 §5.3 AURC):
   * - Computed per query class via computeDynamicGapThreshold()
   * - Overrides the static fallback value in the profile
   * - Enables semantic_preference to resolve with 1.5% gap instead of 5%
   *
   * Decision logic:
   * - C >= T_resolve(Q) AND delta >= T_gap(Q) AND NOT A → RESOLVED + return_result
   * - conformal_set_size >= 2 OR A OR delta < T_gap(Q) → AMBIGUOUS + clarify
   * - else → FAILED/AMBIGUOUS + hybrid_search/fail (per fallback_mode)
   */
  private applyNumericGate(
    input: DecisionInput,
    thresholds: ThresholdEntry,
    rulesApplied: string[],
  ): DecisionState {
    const resolverTrace = input.resolveResult.decisionTrace;
    const C = resolverTrace.decisionConfidenceC;
    const delta = resolverTrace.calibratedGap;
    const A = resolverTrace.ambiguityDetected;
    // Conformal prediction set is calibrated on LTR logit scores. When LTR
    // is saturated (heuristic fallback), conformal set is meaningless (narrow
    // heuristic score range makes conformalSetSize ≥ 2 for virtually every
    // query). Bypass by forcing size=1 so the resolve gate can fire.
    const conformalSetSize = input.ltrSaturated === true
      ? 1
      : (input.conformalSetSize ?? 1);

    // Guard against non-finite confidence/delta from upstream resolver bugs.
    // Without this, NaN flows through gates (NaN >= x is false), the response
    // ships with literal "NaN" in the finalReason text, and operators see
    // misleading "low confidence" failures instead of the real upstream defect.
    //
    // C2 (fail-loud): `delta === undefined` is a legitimate singleton state,
    // NOT an upstream defect. Non-finite (NaN/Infinity) on a PRESENT delta IS
    // a defect and must fail closed.
    if (!Number.isFinite(C) || (delta !== undefined && !Number.isFinite(delta))) {
      rulesApplied.push('NUMERIC_GATE_NONFINITE');
      bootstrapLogger.error(
        {
          C,
          delta,
          queryClass: input.queryPlan.queryClass,
        },
        '[DecisionEngine] Non-finite calibrated confidence/gap from resolver',
      );
      return {
        status: 'failed',
        nextAction: 'fail',
        rulesApplied: [...rulesApplied],
        finalReason: 'Calibrated confidence is non-finite; resolver upstream defect.',
      };
    }

    if (conformalSetSize === 0) {
      rulesApplied.push('NUMERIC_GATE_EMPTY_SET');
      bootstrapLogger.warn(
        {
          conformalSetSize,
          queryClass: input.queryPlan.queryClass,
          candidateCount: input.resolveResult.candidates.length,
        },
        '[DecisionEngine] conformalSetSize=0 — empty conformal set for numeric gate',
      );
      return {
        status: 'failed',
        nextAction: 'fail',
        rulesApplied: [...rulesApplied],
        finalReason: 'Conformal set size is 0; no candidates to evaluate.',
      };
    }

    const cMeetsThreshold = C >= thresholds.resolveTau;
    const numericGateMode: NumericGateMode = thresholds.numericGateMode ?? 'strict';
    // thresholds.gapTau is already the dynamic gap threshold computed by
    // loadThresholds() via computeDynamicGapThreshold(). Using it directly
    // avoids a redundant computation with identical arguments (Rule 30: SSoT).
    const effectiveGapTau = thresholds.gapTau;
    // C2 (fail-loud): a singleton has no meaningful gap. Treat gap as
    // "not applicable" (==true) rather than silently reading `0 < gapTau`
    // and forcing ambiguous.
    const gapMeetsThreshold = delta === undefined ? true : delta >= effectiveGapTau;
    const deltaForLog = delta === undefined ? 'n/a' : delta.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES);

    // Recommendation-style queries do not need identity-style disambiguation.
    // Gap and conformal remain part of the trace, but they are not hard gates.
    if (numericGateMode === 'preference') {
      if (cMeetsThreshold) {
        rulesApplied.push('NUMERIC_GATE_PREFERENCE_MODE');
        return {
          status: 'resolved',
          nextAction: 'return_result',
          rulesApplied: [...rulesApplied],
          finalReason: `Preference-mode gate: calibrated C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} >= T_resolve=${thresholds.resolveTau}; gap/conformal are advisory only.`,
        };
      }

      rulesApplied.push('NUMERIC_GATE_LOW_CONFIDENCE');
      const fallbackMode = input.policy.fallbackMode;
      if (fallbackMode === 'hybrid') {
        rulesApplied.push('FALLBACK_HYBRID_SEARCH');
        return {
          status: 'ambiguous',
          nextAction: 'hybrid_search',
          rulesApplied: [...rulesApplied],
          finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; falling back to hybrid search.`,
        };
      }

      if (fallbackMode === 'clarify') {
        rulesApplied.push('FALLBACK_CLARIFY');
        return {
          status: 'ambiguous',
          nextAction: 'clarify',
          rulesApplied: [...rulesApplied],
          finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; requesting clarification.`,
        };
      }

      // fallbackMode === 'fail'
      rulesApplied.push('FALLBACK_FAIL');
      return {
        status: 'failed',
        nextAction: 'fail',
        rulesApplied: [...rulesApplied],
        finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; no viable path.`,
      };
    }

    // Gate 1: Full resolution (conformal set size blocks resolution per §6.2)
    if (cMeetsThreshold && gapMeetsThreshold && !A && conformalSetSize < 2) {
      rulesApplied.push('NUMERIC_GATE_RESOLVED');
      return {
        status: 'resolved',
        nextAction: 'return_result',
        rulesApplied: [...rulesApplied],
        finalReason: `Calibrated C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} >= T_resolve=${thresholds.resolveTau}, gap=${deltaForLog} >= T_gap=${effectiveGapTau.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)}, no ambiguity.`,
      };
    }

    // Gate 2: Ambiguous conditions — only when there is at least some signal
    // (C > 0). When C = 0 the system has no evidence for any candidate
    // (completely unknown entity), so clarification cannot help; fall through
    // to the failed gate below instead.
    if ((conformalSetSize >= 2 || A || !gapMeetsThreshold) && C > 0) {
      rulesApplied.push('NUMERIC_GATE_AMBIGUOUS');
      const reasons: string[] = [];
      if (conformalSetSize >= 2) {
        reasons.push(`conformal_set_size=${conformalSetSize}`);
        rulesApplied.push('CONFORMAL_SET_AMBIGUOUS');
      }
      if (A) {
        reasons.push('ambiguity_detected');
        rulesApplied.push('AMBIGUITY_DETECTED');
      }
      if (!gapMeetsThreshold) {
        reasons.push(`gap=${deltaForLog} < T_gap=${effectiveGapTau.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)}`);
        rulesApplied.push('GAP_BELOW_THRESHOLD');
      }
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: `Ambiguous: ${reasons.join(', ')}.`,
      };
    }

    // Gate 3: Low confidence fallback
    rulesApplied.push('NUMERIC_GATE_LOW_CONFIDENCE');
    const fallbackMode = input.policy.fallbackMode;
    if (fallbackMode === 'hybrid') {
      rulesApplied.push('FALLBACK_HYBRID_SEARCH');
      return {
        status: 'ambiguous',
        nextAction: 'hybrid_search',
        rulesApplied: [...rulesApplied],
        finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; falling back to hybrid search.`,
      };
    }

    if (fallbackMode === 'clarify') {
      rulesApplied.push('FALLBACK_CLARIFY');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; requesting clarification.`,
      };
    }

    // fallbackMode === 'fail'
    rulesApplied.push('FALLBACK_FAIL');
    return {
      status: 'failed',
      nextAction: 'fail',
      rulesApplied: [...rulesApplied],
      finalReason: `Low confidence C=${C.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)} < T_resolve=${thresholds.resolveTau}; no viable path.`,
    };
  }

  /**
   * Step 3: Evidence obligation (§4.1).
   *
   * Downgrades resolved decisions that lack required evidence:
   * - Resolved + no identity evidence → AMBIGUOUS + clarify
   * - Resolved + constraints but no constraint evidence → AMBIGUOUS + clarify
   * - Resolved + anchor but no anchor evidence → AMBIGUOUS + clarify
   */
  private applyEvidenceObligation(
    input: DecisionInput,
    state: DecisionState,
    rulesApplied: string[],
  ): DecisionState {
    if (state.status !== 'resolved') {
      return state;
    }

    const gateResult: EvidenceGateResult = this.evidenceGate.check(
      state.status,
      input.provenanceContract,
    );

    if (!gateResult.passed) {
      rulesApplied.push('EVIDENCE_GATE_DOWNGRADE');
      if (gateResult.reason) {
        rulesApplied.push(gateResult.reason.split(':')[0] ?? 'EVIDENCE_GATE_UNKNOWN');
      }
      return {
        status: gateResult.downgradeTo ?? 'ambiguous',
        nextAction: gateResult.downgradeAction ?? 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: gateResult.reason ?? 'Evidence obligation not met; downgraded.',
      };
    }

    rulesApplied.push('EVIDENCE_GATE_PASSED');
    return state;
  }

  /**
   * Step 4: Policy overlay.
   *
   * Applies final policy adjustments:
   * - `require_exact=true`: if resolver used approximate matching, downgrade.
   * - `allow_approximate=false`: if only approximate matches, downgrade.
   * - `fallback_mode`: influences next action on non-resolved outcomes.
   */
  private applyPolicyOverlay(
    input: DecisionInput,
    state: DecisionState,
    rulesApplied: string[],
  ): DecisionState {
    const effectiveRetrievalMode = requireEffectiveRetrievalMode(input);

    // require_exact: if resolved but the richer identity trail does not
    // support an exact match, downgrade
    if (input.policy.requireExact && state.status === 'resolved') {
      const hasExactMatch = hasExactMatchCandidate(input.evidenceSummary);

      if (!hasExactMatch) {
        rulesApplied.push('POLICY_REQUIRE_EXACT_DOWNGRADE');
        return {
          status: 'ambiguous',
          nextAction: 'clarify',
          rulesApplied: [...rulesApplied],
          finalReason: 'Policy requires exact match but top candidate is approximate; downgraded to AMBIGUOUS.',
        };
      }
      rulesApplied.push('POLICY_REQUIRE_EXACT_SATISFIED');
    }

    if (
      !input.policy.allowApproximate &&
      state.status === 'resolved' &&
      isExploratoryRetrievalMode(effectiveRetrievalMode)
    ) {
      rulesApplied.push('POLICY_NO_APPROXIMATE_EXPLORATORY_MODE');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason:
          `Policy disallows approximate resolution for exploratory retrieval mode ` +
          `(${effectiveRetrievalMode}); downgraded to AMBIGUOUS.`,
      };
    }

    // allow_approximate: if false and status is ambiguous with hybrid_search,
    // switch to clarify instead (approximate retrieval is not allowed)
    if (!input.policy.allowApproximate && state.nextAction === 'hybrid_search') {
      rulesApplied.push('POLICY_NO_APPROXIMATE_OVERRIDE');
      return {
        ...state,
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: state.finalReason + ' Approximate matching disallowed; switched to clarify.',
      };
    }

    return state;
  }

  private applyNoisyShortQueryGuard(
    input: DecisionInput,
    state: DecisionState,
    rulesApplied: string[],
    dynamicGapThreshold: number,
  ): DecisionState {
    if (state.status !== 'resolved') {
      return state;
    }

    const queryClass = input.queryPlan.queryClass;
    if (
      queryClass !== 'exact_entity' &&
      queryClass !== 'short_entity' &&
      queryClass !== 'ambiguous_short_form'
    ) {
      return state;
    }

    const normalizedCompact = input.queryPlan.normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, '');
    if (normalizedCompact.length === 0 || normalizedCompact.length > NOISY_SHORT_QUERY_MAX_COMPACT_LENGTH) {
      return state;
    }

    const exactnessTier = input.evidenceSummary?.identityEvidence?.exactnessTier ?? 'none';
    if (exactnessTier !== 'alias_fuzzy') {
      return state;
    }

    const resolverTrace = input.resolveResult.decisionTrace;
    const requiredGap = Math.max(dynamicGapThreshold, NOISY_SHORT_QUERY_GAP_FLOOR);
    // C2 (fail-loud): singleton → no runner-up → no gap. A singleton on a
    // noisy short query can still bypass the guard via high confidence,
    // but we never synthesize a "gap=0" to silently fail the margin check.
    const gap = resolverTrace.calibratedGap;
    const gapBypass = gap !== undefined && gap >= requiredGap;
    if (
      resolverTrace.decisionConfidenceC >= NOISY_SHORT_QUERY_CONFIDENCE_FLOOR &&
      (gap === undefined /* singleton */ || gapBypass)
    ) {
      rulesApplied.push('NOISY_SHORT_QUERY_GUARD_BYPASSED_HIGH_CONFIDENCE');
      return state;
    }

    rulesApplied.push('NOISY_SHORT_QUERY_GUARD');
    rulesApplied.push('NOISY_ALIAS_FUZZY_IDENTITY_DETECTED');
    const gapLog = gap === undefined ? 'n/a' : gap.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES);
    return {
      status: 'ambiguous',
      nextAction: 'clarify',
      rulesApplied: [...rulesApplied],
      finalReason:
        `Short query resolved through alias_fuzzy identity evidence without enough margin ` +
        `(C=${resolverTrace.decisionConfidenceC.toFixed(DECISION_TRACE_FLOAT_DECIMAL_PLACES)}, gap=${gapLog}).`,
    };
  }

  /**
   * Loads threshold entry for the query class from the threshold store,
   * falling back to the default profile, and applies dynamic gap threshold
   * calculation per RFC-009 §5.3 (AURC-tuned thresholds).
   *
   * The dynamic gap threshold is computed based on:
   * - Query class (e.g., semantic_preference vs. short_entity)
   * - Calibrated decision confidence C
   *
   * This allows query-specific disambiguation strategies:
   * - semantic_preference: confidence-only admission; gap stays advisory for traces
   * - short_entity: 3% gap (moderate disambiguation)
   * - entity_exact variants: 5-10% gap (strict)
   */
  private async loadThresholds(input: DecisionInput): Promise<ThresholdEntry> {
    const profileId = input.queryPlan.thresholdProfileId;
    let profile = null;
    try {
      profile = await this.thresholdStore.getProfile(profileId);
    } catch (err) {
      bootstrapLogger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          profileId,
        },
        '[DecisionEngine] Threshold profile load failed; falling back to default profile',
      );
    }
    const effectiveProfile = profile ?? DEFAULT_THRESHOLD_PROFILE;

    const queryClass = input.queryPlan.queryClass;
    const thresholdMap = effectiveProfile.perQueryClass as Partial<typeof effectiveProfile.perQueryClass>;
    const profileThreshold = thresholdMap[queryClass];
    const defaultMap = DEFAULT_THRESHOLD_PROFILE.perQueryClass as Partial<
      typeof DEFAULT_THRESHOLD_PROFILE.perQueryClass
    >;
    // Defense in depth: BOTH the active profile AND the default may lack a
    // newly-added QueryClass enum value. Without this guard, baseThreshold would
    // be `undefined` and the next line would crash with `TypeError: Cannot read
    // properties of undefined (reading 'resolveTau')` — silently turning every
    // request for that class into INTERNAL_INCONSISTENCY 5xx.
    const baseThreshold = profileThreshold ?? defaultMap[queryClass];
    if (profileThreshold === undefined) {
      bootstrapLogger.warn(
        {
          profileId: effectiveProfile.id,
          queryClass,
          fallbackProfileId: DEFAULT_THRESHOLD_PROFILE.id,
        },
        '[DecisionEngine] Threshold profile missing query class; using default threshold entry',
      );
    }
    if (baseThreshold === undefined) {
      bootstrapLogger.error(
        { profileId: effectiveProfile.id, queryClass },
        '[DecisionEngine] DEFAULT_THRESHOLD_PROFILE also lacks query class — using emergency fallback',
      );
    }
    // Emergency fallback if a brand-new QueryClass was added without updating
    // either profile. Conservative resolveTau so the engine errs toward
    // "ambiguous" rather than wrong-resolve. gapTau is overridden below by the
    // dynamic gap computation, so only resolveTau matters here.
    const safeResolveTau = baseThreshold?.resolveTau ?? EMERGENCY_FALLBACK_RESOLVE_TAU;

    // Compute dynamic gap threshold (Wave 3 enhancement, RFC-009 §5.3)
    const confidence = input.resolveResult.decisionTrace.decisionConfidenceC;
    const dynamicGapTau = computeDynamicGapThreshold(queryClass, confidence);

    return {
      resolveTau: safeResolveTau,
      gapTau: dynamicGapTau,
      ...(baseThreshold?.numericGateMode !== undefined
        ? { numericGateMode: baseThreshold.numericGateMode }
        : {}),
    };
  }

  /**
   * Assembles the final {@link DecisionOutput} with a complete {@link DecisionTrace}.
   *
   * @param failureReason - When the AdmissionGate rejected the decision, the
   *   machine-readable reason.  Absent on admitted (or non-resolved) decisions.
   * @param admissionTraceRef - The admission trace reference emitted by the gate
   *   on rejection.  Absent on admitted (or non-resolved) decisions.
   * @param dynamicGapThreshold - The dynamic gap threshold computed for the query class.
   *   Used in trace instead of static profile value.
   */
  private buildOutput(
    input: DecisionInput,
    state: DecisionState,
    thresholds: ThresholdEntry,
    snapshot: DecisionSnapshot,
    rulesApplied: readonly string[],
    failureReason?: FailureReason,
    admissionTraceRef?: string,
    dynamicGapThreshold?: number,
  ): DecisionOutput {
    const resolverTrace = input.resolveResult.decisionTrace;
    const topCandidate = input.resolveResult.topEntity;

    const trace: DecisionTrace = {
      decisionStatus: state.status,
      nextAction: state.nextAction,
      inputs: {
        queryClass: input.queryPlan.queryClass,
        effectiveRoute: requireEffectiveRoute(input),
        effectiveRetrievalMode: requireEffectiveRetrievalMode(input),
        ...(input.retrievalKind !== undefined
          ? { retrievalKind: input.retrievalKind }
          : {}),
        policy: {
          requireExact: input.policy.requireExact,
          allowApproximate: input.policy.allowApproximate,
          clarificationBias: input.policy.clarificationBias,
          fallbackMode: input.policy.fallbackMode,
        },
      },
      signals: {
        decisionConfidence: resolverTrace.decisionConfidenceC,
        calibratedGap: resolverTrace.calibratedGap,
        ambiguity: resolverTrace.ambiguityDetected,
      },
      thresholds: {
        resolveThreshold: thresholds.resolveTau,
        gapThreshold: dynamicGapThreshold ?? thresholds.gapTau,
        ...(thresholds.numericGateMode !== undefined
          ? { numericGateMode: thresholds.numericGateMode }
          : {}),
      },
      versions: {
        plannerVersion: input.queryPlan.plannerVersion,
        policyRuleVersion: input.queryPlan.policyRuleVersion,
        thresholdProfileId: input.queryPlan.thresholdProfileId,
      },
      rulesApplied,
      finalReason: state.finalReason,
      ...(input.resolveResult.decisionTrace.queryProvenance !== undefined
        ? {
            queryProvenance: input.resolveResult.decisionTrace.queryProvenance,
          }
        : {}),
    };

    // Build the signal set, using ranking signals if available or a zero-filled default.
    const signalSet = input.rankingSignals ?? {
      entity_integrity_score: 0,
      hard_constraint_pass: 0,
      soft_constraint_score: 0,
      semantic_relevance_score: 0,
      preference_alignment_score: 0,
      popularity_score: 0,
      availability_score: 0,
      uncertainty_penalty: 0,
    };

    const isResolved = state.status === 'resolved' && topCandidate !== undefined;

    return {
      decisionStatus: state.status,
      nextAction: state.nextAction,
      decisionConfidence: resolverTrace.decisionConfidenceC,
      confidenceSemantics: 'calibrated_decision_confidence',
      ...(isResolved
        ? {
            selectedEntity: {
              entityId: topCandidate.entityId,
              canonicalLabel: topCandidate.canonicalLabel,
              identity_signature: identityHash(
                String(topCandidate.entityId),
                snapshot.threshold_profile_id,
                snapshot.planner_version,
              ),
              snapshot_ref: `${snapshot.threshold_profile_id}:${snapshot.planner_version}:${snapshot.policy_rule_version}`,
            },
            chosenEntityId: topCandidate.entityId,
          }
        : {}),
      candidates: input.resolveResult.candidates,
      signalSet,
      evidenceItems: requireDecisionEvidenceItems(input),
      decisionTraceRef: buildAuthorityTraceRef({
        queryPlan: input.queryPlan,
        snapshot,
        route: requireEffectiveRoute(input),
        retrievalMode: requireEffectiveRetrievalMode(input),
        ...(input.retrievalKind !== undefined
          ? { retrievalKind: input.retrievalKind }
          : {}),
        ...(topCandidate !== undefined ? { chosenEntityId: topCandidate.entityId } : {}),
        decisionStatus: state.status,
        nextAction: state.nextAction,
        ...(failureReason !== undefined ? { failureReason } : {}),
      }),
      decisionSnapshot: snapshot,
      decisionTrace: trace,
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(admissionTraceRef !== undefined ? { admissionTraceRef } : {}),
    };
  }
}
