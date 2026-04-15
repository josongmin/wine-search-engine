/**
 * ADR-016 Axis 3 — `entity_reference` verifier.
 *
 * Checks whether the claim's `entityId` / text matches an entity in the
 * evidence record set. Deterministic — zero LLM calls.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';

/** Confidence for a full entity-id match. */
const ENTITY_MATCH_CONFIDENCE = 1.0;
/** Confidence for a normalised-label containment match. */
const LABEL_MATCH_CONFIDENCE = 0.7;

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

export class EntityReferenceVerifier implements AtomicClaimVerifier {
  async verify(
    claim: AtomicClaim,
    ctx: AtomicClaimVerifierContext,
  ): Promise<AtomicClaimVerification> {
    await Promise.resolve();
    for (const rec of ctx.evidenceRecords) {
      const entityId = typeof rec['entity_id'] === 'string' ? rec['entity_id'] : undefined;
      if (claim.entityId !== undefined && entityId === claim.entityId) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: ENTITY_MATCH_CONFIDENCE,
          explanation: `entity_id exact match: ${entityId}`,
        };
      }
      const label = typeof rec['canonical_label'] === 'string' ? rec['canonical_label'] : undefined;
      if (label !== undefined && norm(claim.text).includes(norm(label))) {
        return {
          claimId: claim.id,
          verdict: 'entailed',
          confidence: LABEL_MATCH_CONFIDENCE,
          explanation: `label containment: ${label}`,
        };
      }
    }
    return {
      claimId: claim.id,
      verdict: 'not_entailed',
      confidence: 0,
      explanation: 'no entity evidence matched',
    };
  }
}
