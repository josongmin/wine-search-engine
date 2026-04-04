import type { AliasProposal } from '../model/alias-proposal.js';
import type { ThresholdProposal } from '../model/threshold-proposal.js';
import type { ProposalStore } from '../port/proposal-store.port.js';
import type { SliceMetrics } from '../../evaluation/model/eval-metrics.js';

/**
 * Result of evaluating a proposal through the promotion gate.
 */
export interface PromotionDecision {
  /** Whether the proposal passed the gate. */
  readonly approved: boolean;

  /** Reason codes explaining the decision. */
  readonly reasons: readonly string[];

  /** New status to assign to the proposal. */
  readonly newStatus: string;
}

/**
 * Configuration for the promotion gate.
 */
export interface PromotionGateConfig {
  /** Confidence threshold above which alias proposals are auto-approved (default: 0.9). */
  readonly aliasAutoApproveConfidence: number;

  /** Minimum query count for alias proposals (default: 10). */
  readonly aliasMinQueryCount: number;

  /** Minimum click-through rate for alias proposals (default: 0.7). */
  readonly aliasMinCTR: number;

  /** Minimum eval case count for threshold proposals (default: 100). */
  readonly thresholdMinEvalCases: number;

  /** Minimum expected utility delta for threshold proposals (default: 0.02). */
  readonly thresholdMinUtilityDelta: number;

  /** Whether all promotions are halted (kill switch). */
  readonly killSwitchActive: boolean;
}

/** Default promotion gate configuration per RFC-010 §9. */
const DEFAULT_CONFIG: PromotionGateConfig = {
  aliasAutoApproveConfidence: 0.9,
  aliasMinQueryCount: 10,
  aliasMinCTR: 0.7,
  thresholdMinEvalCases: 100,
  thresholdMinUtilityDelta: 0.02,
  killSwitchActive: false,
};

/**
 * Port for adversarial guard checks on alias proposals.
 * Connects to the alias domain's adversarial detection (RFC-003).
 */
export interface AdversarialGuardPort {
  /**
   * Checks if a surface form is adversarial (homoglyph, injection, etc.).
   *
   * @param surfaceForm - The proposed alias surface form.
   * @returns true if the surface form fails adversarial checks.
   */
  isAdversarial(surfaceForm: string): Promise<boolean>;
}

/**
 * Controls what learning-loop proposals get deployed, per RFC-010 §9.
 *
 * The promotion gate is the safety barrier between the learning loop
 * and production. It enforces:
 * - Alias proposals: adversarial guard, minimum evidence, auto-approval
 *   for high-confidence proposals or queuing for human review.
 * - Threshold proposals: require shadow testing results, minimum eval
 *   case count, no regression on any evaluation slice.
 * - Kill switch: can halt all promotions immediately.
 *
 * The learning loop is shadow-first: proposals never auto-deploy to
 * production without explicit gate clearance.
 */
export class PromotionGate {
  private readonly config: PromotionGateConfig;

  constructor(
    private readonly proposalStore: ProposalStore,
    private readonly adversarialGuard: AdversarialGuardPort,
    config?: Partial<PromotionGateConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluates an alias proposal through the promotion gate.
   *
   * Checks:
   * 1. Kill switch — reject all if active.
   * 2. Adversarial guard — reject if surface form is adversarial.
   * 3. Minimum evidence — reject if below thresholds.
   * 4. Auto-approve if confidence is above the auto-approval threshold.
   * 5. Otherwise, mark as pending for human review.
   *
   * @param proposal - The alias proposal to evaluate.
   * @returns The promotion decision.
   */
  async evaluateAliasProposal(proposal: AliasProposal): Promise<PromotionDecision> {
    const reasons: string[] = [];

    // Kill switch check
    if (this.config.killSwitchActive) {
      reasons.push('KILL_SWITCH_ACTIVE');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Adversarial guard check
    const isAdversarial = await this.adversarialGuard.isAdversarial(proposal.surfaceForm);
    if (isAdversarial) {
      reasons.push('ADVERSARIAL_GUARD_REJECTED');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Minimum evidence checks
    if (proposal.evidence.queryCount < this.config.aliasMinQueryCount) {
      reasons.push('INSUFFICIENT_QUERY_COUNT');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    if (proposal.evidence.clickThroughRate < this.config.aliasMinCTR) {
      reasons.push('INSUFFICIENT_CTR');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Auto-approve high-confidence proposals
    if (proposal.confidence >= this.config.aliasAutoApproveConfidence) {
      reasons.push('AUTO_APPROVED_HIGH_CONFIDENCE');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'approved');
      return { approved: true, reasons, newStatus: 'approved' };
    }

    // Queue for human review (remains pending)
    reasons.push('QUEUED_FOR_HUMAN_REVIEW');
    return { approved: false, reasons, newStatus: 'pending' };
  }

  /**
   * Evaluates a threshold proposal through the promotion gate.
   *
   * Checks:
   * 1. Kill switch — reject all if active.
   * 2. Minimum eval case count.
   * 3. Minimum utility improvement.
   * 4. No regression on any evaluation slice.
   * 5. Shadow testing requirement — only approve proposals that have
   *    completed shadow testing.
   *
   * @param proposal - The threshold proposal to evaluate.
   * @param shadowSliceMetrics - Per-slice metrics from shadow testing (null if not yet tested).
   * @param baselineSliceMetrics - Per-slice metrics from the current production baseline.
   * @returns The promotion decision.
   */
  async evaluateThresholdProposal(
    proposal: ThresholdProposal,
    shadowSliceMetrics: readonly SliceMetrics[] | null,
    baselineSliceMetrics: readonly SliceMetrics[],
  ): Promise<PromotionDecision> {
    const reasons: string[] = [];

    // Kill switch check
    if (this.config.killSwitchActive) {
      reasons.push('KILL_SWITCH_ACTIVE');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Minimum eval case count
    if (proposal.evidence.evalCaseCount < this.config.thresholdMinEvalCases) {
      reasons.push('INSUFFICIENT_EVAL_CASES');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Minimum utility delta
    if (proposal.expectedUtilityDelta < this.config.thresholdMinUtilityDelta) {
      reasons.push('INSUFFICIENT_UTILITY_IMPROVEMENT');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // Shadow testing requirement
    if (shadowSliceMetrics === null) {
      reasons.push('SHADOW_TESTING_REQUIRED');
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'shadow_testing');
      return { approved: false, reasons, newStatus: 'shadow_testing' };
    }

    // No regression on any slice
    const regressions = this.detectSliceRegressions(
      shadowSliceMetrics,
      baselineSliceMetrics,
    );

    if (regressions.length > 0) {
      for (const regression of regressions) {
        reasons.push(`REGRESSION_${regression.sliceTag.toUpperCase()}_${regression.metric.toUpperCase()}`);
      }
      await this.proposalStore.updateProposalStatus(proposal.proposalId, 'rejected');
      return { approved: false, reasons, newStatus: 'rejected' };
    }

    // All checks passed
    reasons.push('ALL_GATES_PASSED');
    await this.proposalStore.updateProposalStatus(proposal.proposalId, 'approved');
    return { approved: true, reasons, newStatus: 'approved' };
  }

  /**
   * Processes all pending alias proposals through the gate.
   *
   * @returns Promotion decisions for each pending proposal.
   */
  async processPendingAliasProposals(): Promise<
    readonly { readonly proposal: AliasProposal; readonly decision: PromotionDecision }[]
  > {
    const pending = await this.proposalStore.getPendingAliasProposals();
    const results: { proposal: AliasProposal; decision: PromotionDecision }[] = [];

    for (const proposal of pending) {
      const decision = await this.evaluateAliasProposal(proposal);
      results.push({ proposal, decision });
    }

    return results;
  }

  /**
   * Activates the kill switch, halting all future promotions.
   */
  activateKillSwitch(): void {
    (this.config as { killSwitchActive: boolean }).killSwitchActive = true;
  }

  /**
   * Deactivates the kill switch, resuming normal promotion processing.
   */
  deactivateKillSwitch(): void {
    (this.config as { killSwitchActive: boolean }).killSwitchActive = false;
  }

  /**
   * Checks whether the kill switch is currently active.
   */
  isKillSwitchActive(): boolean {
    return this.config.killSwitchActive;
  }

  /**
   * Detects regressions in per-slice metrics when comparing shadow results
   * against baseline results.
   *
   * A regression is detected when the shadow utility is lower than the
   * baseline utility for any slice, or the wrong-resolve rate is higher.
   */
  private detectSliceRegressions(
    shadowMetrics: readonly SliceMetrics[],
    baselineMetrics: readonly SliceMetrics[],
  ): readonly { sliceTag: string; metric: string; shadowValue: number; baselineValue: number }[] {
    const baselineMap = new Map(baselineMetrics.map((s) => [s.sliceTag, s]));
    const regressions: { sliceTag: string; metric: string; shadowValue: number; baselineValue: number }[] = [];

    for (const shadow of shadowMetrics) {
      const baseline = baselineMap.get(shadow.sliceTag);
      if (!baseline) continue;

      // Check utility regression (shadow should be >= baseline)
      if (shadow.metrics.decisionUtility < baseline.metrics.decisionUtility - 0.01) {
        regressions.push({
          sliceTag: shadow.sliceTag,
          metric: 'decisionUtility',
          shadowValue: shadow.metrics.decisionUtility,
          baselineValue: baseline.metrics.decisionUtility,
        });
      }

      // Check wrong-resolve regression (shadow should be <= baseline)
      if (shadow.metrics.wrongResolveRate > baseline.metrics.wrongResolveRate + 0.005) {
        regressions.push({
          sliceTag: shadow.sliceTag,
          metric: 'wrongResolveRate',
          shadowValue: shadow.metrics.wrongResolveRate,
          baselineValue: baseline.metrics.wrongResolveRate,
        });
      }
    }

    return regressions;
  }
}
