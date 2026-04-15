/**
 * ADR-016 Axis 3 — shared verifier interface.
 *
 * One verifier per {@link AtomicClaimType}. All 9 verifiers implement
 * this interface so the router can dispatch uniformly.
 *
 * Verifiers are PURE with respect to their inputs — they MAY call the
 * `llm` port for semantic verification, but MUST NOT mutate any input.
 */

import type { ChatLlmPort } from '../../../../domain/ai/port/chat-llm.port.js';
import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type { EvidenceRecord } from '../claim-verifier-deterministic.js';

export interface AtomicClaimVerifierContext {
  readonly evidenceRecords: readonly EvidenceRecord[];
  readonly evidenceContext: string;
  /** Null when no LLM is configured — semantic verifiers fail-closed to
   *  `not_entailed` + `skipped_no_llm` to match legacy router behaviour. */
  readonly llm: ChatLlmPort | null;
}

/** Closed-tuple shape for verification results. Mirrors
 *  {@link ClaimVerification} but keyed on `AtomicClaim.id` and free of
 *  the legacy `claimId`/`verifierUsed` fields. Kept distinct so the
 *  9-class axis does not couple to RFC-020's 5-class internals. */
export interface AtomicClaimVerification {
  readonly claimId: string;
  readonly verdict:
    | 'entailed'
    | 'partially_entailed'
    | 'not_entailed'
    | 'contradicted';
  readonly confidence: number;
  readonly explanation: string;
}

export interface AtomicClaimVerifier {
  verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification>;
}
