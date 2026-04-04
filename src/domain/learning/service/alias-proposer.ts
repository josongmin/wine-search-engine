import type { AliasProposal } from '../model/alias-proposal.js';
import type { ProposalStore } from '../port/proposal-store.port.js';
import type { QueryEntityAggregation } from './feedback-processor.js';

/**
 * Configuration for alias proposal thresholds.
 */
export interface AliasProposerConfig {
  /** Minimum distinct query count to propose an alias (default: 10). */
  readonly minQueryCount: number;

  /** Minimum click-through rate to propose an alias (default: 0.7). */
  readonly minCTR: number;

  /** Minimum session success rate to propose an alias (default: 0.6). */
  readonly minSessionSuccessRate: number;

  /** Confidence threshold for auto-approval (default: 0.9). */
  readonly autoApprovalConfidence: number;
}

/** Default configuration per RFC-010 §4. */
const DEFAULT_CONFIG: AliasProposerConfig = {
  minQueryCount: 10,
  minCTR: 0.7,
  minSessionSuccessRate: 0.6,
  autoApprovalConfidence: 0.9,
};

/**
 * Port for checking whether an alias already exists in the alias table.
 * Prevents proposing duplicates of existing aliases.
 */
export interface ExistingAliasChecker {
  /**
   * Checks if the given surface form already exists as an alias.
   *
   * @param surfaceForm - The surface form to check.
   * @returns true if an alias already exists for this surface form.
   */
  aliasExists(surfaceForm: string): Promise<boolean>;
}

/**
 * Proposes new aliases from observed query patterns, per RFC-010 §4.
 *
 * When query Q consistently resolves to entity E with high user success,
 * the proposer creates an observed_query_alias proposal. Proposals must
 * pass minimum evidence thresholds, duplicate checks, and adversarial
 * screening before being submitted.
 */
export class AliasProposer {
  private readonly config: AliasProposerConfig;

  constructor(
    private readonly proposalStore: ProposalStore,
    private readonly aliasChecker: ExistingAliasChecker,
    config?: Partial<AliasProposerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluates a set of query-entity aggregations and creates alias
   * proposals for patterns that meet the minimum thresholds.
   *
   * @param aggregations - Aggregated feedback statistics.
   * @param generateId - Function to generate unique proposal IDs.
   * @returns Created proposals.
   */
  async proposeAliases(
    aggregations: readonly QueryEntityAggregation[],
    generateId: () => string,
  ): Promise<readonly AliasProposal[]> {
    const proposals: AliasProposal[] = [];

    for (const agg of aggregations) {
      const proposal = await this.evaluateCandidate(agg, generateId);
      if (proposal) {
        await this.proposalStore.saveAliasProposal(proposal);
        proposals.push(proposal);
      }
    }

    return proposals;
  }

  /**
   * Evaluates whether a single query-entity aggregation qualifies for
   * an alias proposal.
   */
  private async evaluateCandidate(
    agg: QueryEntityAggregation,
    generateId: () => string,
  ): Promise<AliasProposal | null> {
    // Check minimum query count
    const totalSignals = agg.positiveCount + agg.negativeCount;
    if (totalSignals < this.config.minQueryCount) return null;

    // Compute click-through rate
    const ctr = totalSignals > 0 ? agg.clicks / totalSignals : 0;
    if (ctr < this.config.minCTR) return null;

    // Compute session success rate
    const sessionSuccessRate =
      agg.sessionCount > 0 ? agg.sessionSuccesses / agg.sessionCount : 0;
    if (sessionSuccessRate < this.config.minSessionSuccessRate) return null;

    // Duplicate check against existing aliases
    const exists = await this.aliasChecker.aliasExists(agg.query);
    if (exists) return null;

    // Adversarial checks
    if (this.isAdversarial(agg.query)) return null;

    // Compute confidence based on evidence strength
    const confidence = this.computeConfidence(agg, ctr, sessionSuccessRate);

    return {
      proposalId: generateId(),
      surfaceForm: agg.query,
      targetEntityId: agg.entityId,
      proposedType: 'observed_query_alias',
      evidence: {
        queryCount: totalSignals,
        clickThroughRate: ctr,
        sessionSuccessRate,
      },
      confidence,
      status: 'pending',
      createdAt: new Date(),
    };
  }

  /**
   * Checks for adversarial patterns in a proposed alias surface form.
   *
   * Detects:
   * - Homoglyph attacks (mixed scripts suggesting spoofing).
   * - Suspiciously high velocity (very short surface forms that could collide).
   */
  private isAdversarial(surfaceForm: string): boolean {
    // Homoglyph detection: check for mixed Unicode scripts
    if (this.hasMixedScripts(surfaceForm)) return true;

    // Reject extremely short surface forms (single character can be too ambiguous)
    if (surfaceForm.trim().length < 2) return true;

    return false;
  }

  /**
   * Detects mixed Unicode scripts that may indicate homoglyph attacks.
   * Flags strings that contain characters from both Latin and Cyrillic,
   * or Latin and Greek scripts mixed together.
   */
  private hasMixedScripts(text: string): boolean {
    let hasLatin = false;
    let hasCyrillic = false;
    let hasGreek = false;

    for (const char of text) {
      const code = char.codePointAt(0);
      if (code === undefined) continue;

      // Basic Latin and Latin Extended
      if (
        (code >= 0x0041 && code <= 0x024f) ||
        (code >= 0x1e00 && code <= 0x1eff)
      ) {
        hasLatin = true;
      }
      // Cyrillic
      if (code >= 0x0400 && code <= 0x04ff) {
        hasCyrillic = true;
      }
      // Greek
      if (code >= 0x0370 && code <= 0x03ff) {
        hasGreek = true;
      }
    }

    // Mixed Latin+Cyrillic or Latin+Greek is suspicious
    return (hasLatin && hasCyrillic) || (hasLatin && hasGreek);
  }

  /**
   * Computes a confidence score for the alias proposal based on
   * the strength of evidence.
   */
  private computeConfidence(
    agg: QueryEntityAggregation,
    ctr: number,
    sessionSuccessRate: number,
  ): number {
    // Weighted combination of evidence signals
    const totalSignals = agg.positiveCount + agg.negativeCount;

    // Volume factor: more signals = higher confidence (saturating)
    const volumeFactor = Math.min(1.0, totalSignals / 50);

    // CTR factor
    const ctrFactor = ctr;

    // Session success factor
    const sessionFactor = sessionSuccessRate;

    // Purchase signal is a strong indicator
    const purchaseFactor = agg.purchases > 0 ? 0.1 : 0;

    const raw = 0.3 * volumeFactor + 0.3 * ctrFactor + 0.2 * sessionFactor + 0.2 + purchaseFactor;

    return Math.min(1.0, Math.max(0, raw));
  }
}
