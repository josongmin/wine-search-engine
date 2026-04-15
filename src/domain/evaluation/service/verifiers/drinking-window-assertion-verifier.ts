/**
 * ADR-016 Axis 3 — `drinking_window_assertion` verifier.
 *
 * Extracts two 4-digit years from the claim (start, end) and compares
 * against `drinking_window_start` / `drinking_window_end` evidence
 * within a ±2 / ±3 year tolerance (matches RFC-020 RANGE_TOLERANCES).
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

/** ±years tolerance for drinking_window_start (matches RFC-020 RANGE_TOLERANCES). */
const START_TOLERANCE_YEARS = 2;
/** ±years tolerance for drinking_window_end. */
const END_TOLERANCE_YEARS = 3;

const CONF_EXACT = 0.95;
const CONF_CONTRADICTED = 0.9;

function extractYears(s: string): number[] {
  const out: number[] = [];
  const re = /(19[0-9]{2}|20[0-9]{2})/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
    m = re.exec(s);
  }
  return out;
}

export class DrinkingWindowAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    const years = extractYears(claim.text);
    if (years.length === 0) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'no year in drinking-window claim',
      };
    }
    const claimStart = years[0] ?? undefined;
    const claimEnd = years.length > 1 ? years[1] : undefined;
    for (const rec of ctx.evidenceRecords) {
      const eStart = rec['drinking_window_start'];
      const eEnd = rec['drinking_window_end'];
      if (typeof eStart !== 'number') continue;
      if (claimStart !== undefined && Math.abs(eStart - claimStart) > START_TOLERANCE_YEARS) {
        return {
          claimId: claim.id,
          verdict: 'contradicted',
          confidence: CONF_CONTRADICTED,
          explanation: `drinking-window start mismatch (claim=${claimStart}, evidence=${eStart})`,
        };
      }
      if (
        claimEnd !== undefined
        && typeof eEnd === 'number'
        && Math.abs(eEnd - claimEnd) > END_TOLERANCE_YEARS
      ) {
        return {
          claimId: claim.id,
          verdict: 'contradicted',
          confidence: CONF_CONTRADICTED,
          explanation: `drinking-window end mismatch (claim=${claimEnd}, evidence=${eEnd})`,
        };
      }
      return {
        claimId: claim.id,
        verdict: 'entailed',
        confidence: CONF_EXACT,
        explanation: 'drinking window within tolerance',
      };
    }
    return {
      claimId: claim.id,
      verdict: 'not_entailed',
      confidence: 0,
      explanation: 'no drinking-window evidence',
    };
  }
}
