/**
 * ADR-016 Axis 3 — `vintage_assertion` verifier.
 *
 * Exact vintage-year match. Extracts a 4-digit year from the claim
 * text and compares against `vintage_year` evidence.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

const CONF_EXACT = 1.0;
const CONF_CONTRADICTED = 0.9;

const VINTAGE_YEAR_REGEX = /(19[0-9]{2}|20[0-9]{2})/;

function extractYear(s: string): number | undefined {
  const m = s.match(VINTAGE_YEAR_REGEX);
  if (m === null) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

export class VintageAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    const claimYear = extractYear(claim.text);
    if (claimYear === undefined) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'no 4-digit year in claim text',
      };
    }
    for (const rec of ctx.evidenceRecords) {
      const v = rec['vintage_year'];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v === claimYear) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: CONF_EXACT,
          explanation: `vintage exact match: ${claimYear}`,
        };
      }
      return {
        claimId: claim.id,
        verdict: 'contradicted',
        confidence: CONF_CONTRADICTED,
        explanation: `vintage mismatch (claim=${claimYear}, evidence=${v})`,
      };
    }
    return {
      claimId: claim.id,
      verdict: 'not_entailed',
      confidence: 0,
      explanation: 'no vintage_year evidence',
    };
  }
}
