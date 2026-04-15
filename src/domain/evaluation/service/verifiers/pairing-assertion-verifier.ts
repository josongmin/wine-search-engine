/**
 * ADR-016 Axis 3 — `pairing_assertion` verifier.
 *
 * NLI via LLM. No deterministic ground truth for "does this wine pair
 * with this dish"; we delegate to the semantic claim verifier's LLM
 * path when available. Fail-closed to `not_entailed` + `skipped_no_llm`
 * when no LLM is configured.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';
import { ATOMIC_CLAIM_EVIDENCE_CONTEXT_PROMPT_MAX_CHARS } from './atomic-claim-llm-prompt-limits.js';

const CONF_SEMANTIC_FLOOR = 0.5;
const CONF_ENTAILED = 0.85;

export class PairingAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    if (ctx.llm === null) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'pairing verification skipped: no LLM configured',
      };
    }
    const prompt = [
      'Does the following wine evidence support the pairing claim?',
      '',
      `Claim: ${claim.text}`,
      '',
      'Evidence:',
      ctx.evidenceContext.slice(0, ATOMIC_CLAIM_EVIDENCE_CONTEXT_PROMPT_MAX_CHARS),
      '',
      'Answer with one token: ENTAILED, PARTIAL, or NOT_ENTAILED.',
    ].join('\n');
    try {
      const result = await ctx.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        seed: 1,
        maxOutputTokens: 8,
      });
      const tok = result.text.trim().toUpperCase();
      if (tok.startsWith('ENTAILED')) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: CONF_ENTAILED,
          explanation: 'LLM NLI: ENTAILED',
        };
      }
      if (tok.startsWith('PARTIAL')) {
        return {
          claimId: claim.id,
          verdict: 'partially_entailed',
          confidence: CONF_SEMANTIC_FLOOR,
          explanation: 'LLM NLI: PARTIAL',
        };
      }
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: CONF_SEMANTIC_FLOOR,
        explanation: 'LLM NLI: NOT_ENTAILED',
      };
    } catch {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'pairing verification LLM error',
      };
    }
  }
}
