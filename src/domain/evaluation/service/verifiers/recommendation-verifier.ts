/**
 * ADR-016 Axis 3 — `recommendation` verifier.
 *
 * `NoopVerifier`: recommendations are subjective and have no ground
 * truth. Always returns `entailed` with low confidence, so aggregation
 * does not penalise responses that include recommendations.
 *
 * This is the documented ADR-016 §2.1 mapping for recommendations.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

/** Pass-through confidence for no-op recommendations. Low enough that
 *  aggregators can weight it down; high enough to not look like failure. */
const RECOMMENDATION_PASSTHROUGH_CONFIDENCE = 0.5;

export class NoopVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    _ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    return {
      claimId: claim.id,
      verdict: 'entailed',
      confidence: RECOMMENDATION_PASSTHROUGH_CONFIDENCE,
      explanation: 'recommendation: no ground truth (NoopVerifier)',
    };
  }
}
