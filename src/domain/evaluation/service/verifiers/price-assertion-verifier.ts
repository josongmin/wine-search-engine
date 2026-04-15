/**
 * ADR-016 Axis 3 — `price_assertion` verifier.
 *
 * ±10% tolerance range match. Extracts a numeric value from the claim
 * text (first positive number) and compares against `price_usd` /
 * `price_band_numeric` evidence fields.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

/** ADR-016 price tolerance — stricter than the derived-attribute
 *  tolerance (RFC-020 uses ±15%) because price mis-statement is
 *  reputationally costlier than e.g. tannin. */
const PRICE_TOLERANCE_FRACTION = 0.1;
const CONF_IN_BAND = 0.95;
const CONF_CONTRADICTED = 0.9;

function extractFirstNumber(s: string): number | undefined {
  const m = s.match(/[0-9]+(?:\.[0-9]+)?/);
  if (m === null) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

export class PriceAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    const claimValue = extractFirstNumber(claim.text);
    if (claimValue === undefined) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'no numeric price in claim text',
      };
    }
    for (const rec of ctx.evidenceRecords) {
      const priceRaw = rec['price_usd'];
      if (typeof priceRaw !== 'number' || !Number.isFinite(priceRaw)) continue;
      const diff = Math.abs(priceRaw - claimValue);
      const tolerance = priceRaw * PRICE_TOLERANCE_FRACTION;
      if (diff <= tolerance) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: CONF_IN_BAND,
          explanation: `price within ±10% (claim=${claimValue}, evidence=${priceRaw})`,
        };
      }
      // Out-of-band on a field we know — surface as contradiction.
      return {
        claimId: claim.id,
        verdict: 'contradicted',
        confidence: CONF_CONTRADICTED,
        explanation: `price outside ±10% (claim=${claimValue}, evidence=${priceRaw})`,
      };
    }
    return {
      claimId: claim.id,
      verdict: 'not_entailed',
      confidence: 0,
      explanation: 'no price_usd evidence',
    };
  }
}
