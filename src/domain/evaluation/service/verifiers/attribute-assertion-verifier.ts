/**
 * ADR-016 Axis 3 — `attribute_assertion` verifier.
 *
 * Checks derived structured attributes (body, tannin, acidity, sweetness,
 * finish_length, critic_score_normalized). Deterministic substring match
 * against known evidence fields.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

const ATTRIBUTE_KEYS = [
  'body',
  'tannin',
  'acidity',
  'sweetness',
  'finish_length',
  'critic_score_normalized',
  'alcohol_pct',
] as const;

const CONF_EXACT = 0.95;
const CONF_PARTIAL = 0.6;

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

export class AttributeAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    const claimText = norm(claim.text);
    for (const rec of ctx.evidenceRecords) {
      for (const key of ATTRIBUTE_KEYS) {
        const v = rec[key];
        if (v === undefined || v === null) continue;
        const str = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
        if (str.length === 0) continue;
        if (claimText.includes(norm(str))) {
          return {
            claimId: claim.id,
            verdict: 'entailed',
            confidence: CONF_EXACT,
            explanation: `${key} exact match`,
          };
        }
        if (norm(str).length >= 3 && norm(str).slice(0, 3) === claimText.slice(0, 3)) {
          return {
            claimId: claim.id,
            verdict: 'partially_entailed',
            confidence: CONF_PARTIAL,
            explanation: `${key} partial match`,
          };
        }
      }
    }
    return {
      claimId: claim.id,
      verdict: 'not_entailed',
      confidence: 0,
      explanation: 'no attribute evidence matched',
    };
  }
}
