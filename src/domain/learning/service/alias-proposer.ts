import type { AliasProposal } from '../model/alias-proposal.js';
import type { ProposalStore } from '../port/proposal-store.port.js';
import type { QueryEntityAggregation } from './feedback-processor.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/** Unicode blocks for mixed-script homoglyph detection (alias safety). */
const UNICODE_LATIN_BASIC_START = 0x0041;
const UNICODE_LATIN_EXTENDED_END = 0x024f;
const UNICODE_LATIN_EXTENDED_ADDITIONAL_START = 0x1e00;
const UNICODE_LATIN_EXTENDED_ADDITIONAL_END = 0x1eff;
const UNICODE_CYRILLIC_START = 0x0400;
const UNICODE_CYRILLIC_END = 0x04ff;
const UNICODE_GREEK_START = 0x0370;
const UNICODE_GREEK_END = 0x03ff;
const UNICODE_ARMENIAN_START = 0x0530;
const UNICODE_ARMENIAN_END = 0x058f;
const UNICODE_CHEROKEE_START = 0x13a0;
const UNICODE_CHEROKEE_END = 0x13ff;

/** Saturating divisor for evidence volume → confidence factor. */
const ALIAS_CONFIDENCE_VOLUME_SIGNAL_CAP = 50;
/** Minimum distinct purchases before purchase signal contributes. */
const ALIAS_CONFIDENCE_MIN_PURCHASES = 3;
/** Purchase count at which purchase factor saturates to 1. */
const ALIAS_CONFIDENCE_PURCHASE_SATURATION = 5;
const ALIAS_CONFIDENCE_WEIGHT_VOLUME = 0.3;
const ALIAS_CONFIDENCE_WEIGHT_CTR = 0.3;
const ALIAS_CONFIDENCE_WEIGHT_SESSION = 0.2;
const ALIAS_CONFIDENCE_WEIGHT_PURCHASE = 0.2;

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
    let hasArmenian = false;
    let hasCherokee = false;

    for (const char of text) {
      const code = char.codePointAt(0);
      if (code === undefined) continue;

      // Basic Latin and Latin Extended
      if (
        (code >= UNICODE_LATIN_BASIC_START && code <= UNICODE_LATIN_EXTENDED_END) ||
        (
          code >= UNICODE_LATIN_EXTENDED_ADDITIONAL_START
          && code <= UNICODE_LATIN_EXTENDED_ADDITIONAL_END
        )
      ) {
        hasLatin = true;
      }
      // Cyrillic
      if (code >= UNICODE_CYRILLIC_START && code <= UNICODE_CYRILLIC_END) {
        hasCyrillic = true;
      }
      // Greek
      if (code >= UNICODE_GREEK_START && code <= UNICODE_GREEK_END) {
        hasGreek = true;
      }
      // Armenian (homoglyph attack vector against Latin)
      if (code >= UNICODE_ARMENIAN_START && code <= UNICODE_ARMENIAN_END) {
        hasArmenian = true;
      }
      // Cherokee (classic homoglyph source)
      if (code >= UNICODE_CHEROKEE_START && code <= UNICODE_CHEROKEE_END) {
        hasCherokee = true;
      }
    }

    // Any Latin + non-Latin lookalike script is suspicious.
    return hasLatin && (hasCyrillic || hasGreek || hasArmenian || hasCherokee);
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
    const volumeFactor = Math.min(1.0, totalSignals / ALIAS_CONFIDENCE_VOLUME_SIGNAL_CAP);

    // CTR factor
    const ctrFactor = ctr;

    // Session success factor
    const sessionFactor = sessionSuccessRate;

    // Purchase signal is a strong indicator, but a SINGLE purchase can be a
    // bot/abuse vector. Require at least 3 distinct purchases for any
    // contribution and saturate at 5 (proportional, not binary). Without
    // this, one purchase from any session could push raw confidence past
    // the auto-approval threshold.
    const purchaseFactor =
      agg.purchases >= ALIAS_CONFIDENCE_MIN_PURCHASES
        ? Math.min(1, agg.purchases / ALIAS_CONFIDENCE_PURCHASE_SATURATION)
        : 0;

    const raw =
      ALIAS_CONFIDENCE_WEIGHT_VOLUME * volumeFactor
      + ALIAS_CONFIDENCE_WEIGHT_CTR * ctrFactor
      + ALIAS_CONFIDENCE_WEIGHT_SESSION * sessionFactor
      + ALIAS_CONFIDENCE_WEIGHT_PURCHASE * purchaseFactor;

    return clamp01(raw);
  }
}
