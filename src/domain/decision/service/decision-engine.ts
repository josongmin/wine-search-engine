import type { DecisionStatus, NextAction, DecisionSnapshot } from '../../shared/types/index.js';
import type { ThresholdStore } from '../../query/port/threshold-store.port.js';
import type { ThresholdEntry } from '../../query/model/threshold-profile.js';
import { DEFAULT_THRESHOLD_PROFILE, computeDynamicGapThreshold } from '../../query/model/threshold-profile.js';
import type { DecisionInput } from '../model/decision-input.js';
import type { DecisionOutput } from '../model/decision-output.js';
import type { DecisionTrace } from '../model/decision-trace.js';
import { EvidenceGate, type EvidenceGateResult } from './evidence-gate.js';
import { AdmissionGate } from './admission-gate.js';
import type { FailureReason } from '../model/failure-reason.js';
import { identityHash } from '../../shared/utils/hash.js';
import type { ConfidenceRefusalPolicy } from './confidence-refusal.js';

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

const NOISY_SHORT_QUERY_STRATEGIES = new Set([
  'fuzzy_char_ngram',
  'transliterated_fuzzy',
]);
const NOISY_SHORT_QUERY_MAX_COMPACT_LENGTH = 12;
const NOISY_SHORT_QUERY_CONFIDENCE_FLOOR = 0.9;
const NOISY_SHORT_QUERY_GAP_FLOOR = 0.08;

function deriveAdmissionContext(
  input: DecisionInput,
): NonNullable<DecisionInput['admissionContext']> {
  if (input.admissionContext !== undefined) {
    return input.admissionContext;
  }
  if (input.queryPlan.admission_context !== undefined) {
    return input.queryPlan.admission_context;
  }
  const effectiveRoute = input.effectiveRoute ?? input.queryPlan.route;
  return {
    requires_identity_seal:
      input.queryPlan.intent === 'entity_exact' ||
      input.queryPlan.intent === 'entity_fuzzy' ||
      input.queryPlan.intent === 'comparison_search' ||
      input.queryPlan.intent === 'mixed_query' ||
      effectiveRoute === 'mixed',
    requires_constraint_evidence: input.queryPlan.constraints.hard.length > 0,
    requires_anchor_evidence: effectiveRoute === 'mixed' && input.queryPlan.anchors.length > 0,
  };
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
   * @param input - Aggregated signals from all pipeline stages.
   * @param snapshot - System version snapshot at decision time.
   * @returns The binding decision output with full trace.
   */
  async decide(input: DecisionInput, snapshot: DecisionSnapshot): Promise<DecisionOutput> {
    const thresholds = await this.loadThresholds(input);
    const rulesApplied: string[] = [];

    // Compute dynamic gap threshold (RFC-009 §5.3)
    const C = input.resolverResult.decisionTrace.decisionConfidenceC;
    const dynamicGapThreshold = computeDynamicGapThreshold(input.queryPlan.queryClass, C);

    // ── Step 1: Policy pre-processing (RFC-007 §6.3) ───────────────
    const policyResult = this.applyPolicyPreprocessing(input, rulesApplied);
    if (policyResult !== null) {
      return this.buildOutput(input, policyResult, thresholds, snapshot, rulesApplied, undefined, undefined, dynamicGapThreshold);
    }

    // ── Step 2: Numeric gate (RFC-007 §6.2) ────────────────────────
    const numericState = this.applyNumericGate(input, thresholds, rulesApplied);

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
    // require_clarification policy override
    if (input.policy.requireClarification) {
      rulesApplied.push('POLICY_REQUIRE_CLARIFICATION');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: 'Policy requires clarification; decision short-circuited to AMBIGUOUS.',
      };
    }

    // Uncertainty-driven overrides
    if (input.uncertainty.decisionEffect === 'force_clarify') {
      rulesApplied.push('UNCERTAINTY_FORCE_CLARIFY');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: 'Uncertainty assessment forces clarification; decision short-circuited to AMBIGUOUS.',
      };
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
    const resolverTrace = input.resolverResult.decisionTrace;
    const C = resolverTrace.decisionConfidenceC;
    const delta = resolverTrace.calibratedGap;
    const A = resolverTrace.ambiguityDetected;
    const conformalSetSize = input.conformalSetSize ?? 1;

    const cMeetsThreshold = C >= thresholds.resolveTau;
    // Use dynamic gap threshold based on query class (RFC-009 §5.3)
    const dynamicGapThreshold = computeDynamicGapThreshold(input.queryPlan.queryClass, C);
    const gapMeetsThreshold = delta >= dynamicGapThreshold;

    // Gate 1: Full resolution (conformal set size blocks resolution per §6.2)
    if (cMeetsThreshold && gapMeetsThreshold && !A && conformalSetSize < 2) {
      rulesApplied.push('NUMERIC_GATE_RESOLVED');
      return {
        status: 'resolved',
        nextAction: 'return_result',
        rulesApplied: [...rulesApplied],
        finalReason: `Calibrated C=${C.toFixed(4)} >= T_resolve=${thresholds.resolveTau}, gap=${delta.toFixed(4)} >= T_gap=${dynamicGapThreshold.toFixed(4)}, no ambiguity.`,
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
        reasons.push(`gap=${delta.toFixed(4)} < T_gap=${dynamicGapThreshold.toFixed(4)}`);
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
        finalReason: `Low confidence C=${C.toFixed(4)} < T_resolve=${thresholds.resolveTau}; falling back to hybrid search.`,
      };
    }

    if (fallbackMode === 'clarify') {
      rulesApplied.push('FALLBACK_CLARIFY');
      return {
        status: 'ambiguous',
        nextAction: 'clarify',
        rulesApplied: [...rulesApplied],
        finalReason: `Low confidence C=${C.toFixed(4)} < T_resolve=${thresholds.resolveTau}; requesting clarification.`,
      };
    }

    // fallbackMode === 'fail'
    rulesApplied.push('FALLBACK_FAIL');
    return {
      status: 'failed',
      nextAction: 'fail',
      rulesApplied: [...rulesApplied],
      finalReason: `Low confidence C=${C.toFixed(4)} < T_resolve=${thresholds.resolveTau}; no viable path.`,
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

    const admissionContext = deriveAdmissionContext(input);
    const hasConstraints = admissionContext?.requires_constraint_evidence === true;
    const hasAnchor = admissionContext?.requires_anchor_evidence === true;

    const gateResult: EvidenceGateResult = this.evidenceGate.check(
      state.status,
      input.evidenceSummary,
      hasConstraints,
      hasAnchor,
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
    // require_exact: if resolved but no exact canonical match, downgrade
    if (input.policy.requireExact && state.status === 'resolved') {
      const topCandidate = input.resolverResult.candidates[0];
      const hasExactMatch = topCandidate !== undefined &&
        topCandidate.calibratedScore >= 0.99;

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
    if (queryClass !== 'short_entity' && queryClass !== 'ambiguous_short_form') {
      return state;
    }

    const normalizedCompact = input.queryPlan.normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, '');
    if (normalizedCompact.length === 0 || normalizedCompact.length > NOISY_SHORT_QUERY_MAX_COMPACT_LENGTH) {
      return state;
    }

    const strategies = input.resolverResult.decisionTrace.queryProvenance?.anchorLookupStrategies ?? [];
    const hasNoisyLookupStrategy = strategies.some((strategy) => NOISY_SHORT_QUERY_STRATEGIES.has(strategy));
    if (!hasNoisyLookupStrategy) {
      return state;
    }

    const resolverTrace = input.resolverResult.decisionTrace;
    const requiredGap = Math.max(dynamicGapThreshold, NOISY_SHORT_QUERY_GAP_FLOOR);
    if (
      resolverTrace.decisionConfidenceC >= NOISY_SHORT_QUERY_CONFIDENCE_FLOOR &&
      resolverTrace.calibratedGap >= requiredGap
    ) {
      rulesApplied.push('NOISY_SHORT_QUERY_GUARD_BYPASSED_HIGH_CONFIDENCE');
      return state;
    }

    rulesApplied.push('NOISY_SHORT_QUERY_GUARD');
    rulesApplied.push('NOISY_LOOKUP_STRATEGY_DETECTED');
    return {
      status: 'ambiguous',
      nextAction: 'clarify',
      rulesApplied: [...rulesApplied],
      finalReason:
        `Short query used noisy lookup strategy (${strategies.join(', ')}) without enough margin ` +
        `(C=${resolverTrace.decisionConfidenceC.toFixed(4)}, gap=${resolverTrace.calibratedGap.toFixed(4)}).`,
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
   * - semantic_preference: 1-1.5% gap (fuzzy matching OK)
   * - short_entity: 3% gap (moderate disambiguation)
   * - entity_exact variants: 5-10% gap (strict)
   */
  private async loadThresholds(input: DecisionInput): Promise<ThresholdEntry> {
    const profileId = input.queryPlan.thresholdProfileId;
    const profile = await this.thresholdStore.getProfile(profileId);
    const effectiveProfile = profile ?? DEFAULT_THRESHOLD_PROFILE;

    const queryClass = input.queryPlan.queryClass;
    const baseThreshold = effectiveProfile.perQueryClass[queryClass];

    // Compute dynamic gap threshold (Wave 3 enhancement, RFC-009 §5.3)
    const confidence = input.resolverResult.decisionTrace.decisionConfidenceC;
    const dynamicGapTau = computeDynamicGapThreshold(queryClass, confidence);

    // Return threshold entry with dynamic gap override
    return {
      resolveTau: baseThreshold.resolveTau,
      gapTau: dynamicGapTau,
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
    const resolverTrace = input.resolverResult.decisionTrace;
    const topCandidate = input.resolverResult.topEntity;

    const trace: DecisionTrace = {
      decisionStatus: state.status,
      nextAction: state.nextAction,
      inputs: {
        queryClass: input.queryPlan.queryClass,
        effectiveRoute: input.effectiveRoute ?? input.queryPlan.route,
        policy: {
          requireExact: input.policy.requireExact,
          allowApproximate: input.policy.allowApproximate,
          requireClarification: input.policy.requireClarification,
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
      },
      versions: {
        plannerVersion: input.queryPlan.plannerVersion,
        policyRuleVersion: input.queryPlan.policyRuleVersion,
        thresholdProfileId: input.queryPlan.thresholdProfileId,
      },
      rulesApplied,
      finalReason: state.finalReason,
      ...(input.resolverResult.decisionTrace.queryProvenance !== undefined
        ? {
            queryProvenance: input.resolverResult.decisionTrace.queryProvenance,
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
      candidates: input.resolverResult.candidates,
      signalSet,
      evidenceItems: input.evidenceItems ?? [],
      decisionTraceRef: `trace:${input.queryPlan.queryClass}:${String(Date.now())}`,
      decisionSnapshot: snapshot,
      decisionTrace: trace,
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(admissionTraceRef !== undefined ? { admissionTraceRef } : {}),
    };
  }
}
