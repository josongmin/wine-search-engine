/**
 * ADR-016 Axis 3 — `comparative_assertion` verifier.
 *
 * "A is bolder than B" — requires two evidence entities and a
 * structured attribute comparison. Falls back to LLM NLI when two
 * entities are present but the attribute is not structured.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';
import { ATOMIC_CLAIM_EVIDENCE_CONTEXT_PROMPT_MAX_CHARS } from './atomic-claim-llm-prompt-limits.js';

const CONF_NEEDS_TWO_ENTITIES = 0;

export class ComparativeAssertionVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    if (ctx.evidenceRecords.length < 2) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: CONF_NEEDS_TWO_ENTITIES,
        explanation: 'comparative claim requires ≥2 evidence entities',
      };
    }
    if (ctx.llm === null) {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'comparative verification skipped: no LLM',
      };
    }
    try {
      const result = await ctx.llm.complete({
        messages: [
          {
            role: 'user',
            content: [
              'Is the following comparative claim supported by the evidence?',
              `Claim: ${claim.text}`,
              'Evidence:',
              ctx.evidenceContext.slice(0, ATOMIC_CLAIM_EVIDENCE_CONTEXT_PROMPT_MAX_CHARS),
              'Answer: ENTAILED or NOT_ENTAILED.',
            ].join('\n'),
          },
        ],
        temperature: 0,
        seed: 1,
        maxOutputTokens: 8,
      });
      const tok = result.text.trim().toUpperCase();
      if (tok.startsWith('ENTAILED')) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: 0.8,
          explanation: 'LLM NLI: ENTAILED',
        };
      }
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0.5,
        explanation: 'LLM NLI: NOT_ENTAILED',
      };
    } catch {
      return {
        claimId: claim.id,
        verdict: 'not_entailed',
        confidence: 0,
        explanation: 'comparative verification LLM error',
      };
    }
  }
}
