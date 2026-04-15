/**
 * ADR-016 Axis 3 — atomic claim verifier router.
 *
 * Maps each of the 9 {@link AtomicClaimType} values to its verifier
 * class. This router is separate from RFC-020's `claim-verifier-router.ts`
 * because the two routing axes are orthogonal (9-class type vs 5-class
 * category). The RFC-020 router stays authoritative for shadow-mode
 * legacy claims; the 9-class router is used when `GCE_PRIMARY=true`.
 *
 * Adding a new `AtomicClaimType` variant requires adding a branch here
 * AND updating `DEFAULT_TYPE_TO_CATEGORY_MAPPING` in
 * `atomic-claim-type.ts`. Missing branches fail loudly at runtime.
 */

import type { AtomicClaim } from '../../../response/model/grounded-claim.js';
import type { AtomicClaimType } from '../../../response/model/atomic-claim-type.js';
import type {
  AtomicClaimVerifier,
  AtomicClaimVerifierContext,
  AtomicClaimVerification,
} from './atomic-claim-verifier.port.js';
import { EntityReferenceVerifier } from './entity-reference-verifier.js';
import { AttributeAssertionVerifier } from './attribute-assertion-verifier.js';
import { PriceAssertionVerifier } from './price-assertion-verifier.js';
import { VintageAssertionVerifier } from './vintage-assertion-verifier.js';
import { PairingAssertionVerifier } from './pairing-assertion-verifier.js';
import { ComparativeAssertionVerifier } from './comparative-assertion-verifier.js';
import { DrinkingWindowAssertionVerifier } from './drinking-window-assertion-verifier.js';
import { StyleAssertionVerifier } from './style-assertion-verifier.js';
import { NoopVerifier } from './recommendation-verifier.js';

/** Frozen singleton registry. All verifiers are stateless so a single
 *  instance per process suffices (CLAUDE.md rule 16: allocate
 *  deterministic constructs at module scope). */
const VERIFIER_REGISTRY: Readonly<Record<AtomicClaimType, AtomicClaimVerifier>> = Object.freeze({
  entity_reference: new EntityReferenceVerifier(),
  attribute_assertion: new AttributeAssertionVerifier(),
  price_assertion: new PriceAssertionVerifier(),
  vintage_assertion: new VintageAssertionVerifier(),
  pairing_assertion: new PairingAssertionVerifier(),
  comparative_assertion: new ComparativeAssertionVerifier(),
  drinking_window_assertion: new DrinkingWindowAssertionVerifier(),
  style_assertion: new StyleAssertionVerifier(),
  recommendation: new NoopVerifier(),
});

/** Resolve the verifier for a given atomic claim type. Throws on
 *  unknown type so the schema refine / router branch-coverage
 *  regression catches drift. */
export function resolveAtomicClaimVerifier(type: AtomicClaimType): AtomicClaimVerifier {
  return VERIFIER_REGISTRY[type];
}

/** Run verification for a batch of atomic claims. Order preserved. */
export async function verifyAtomicClaims(
  claims: readonly AtomicClaim[],
  ctx: AtomicClaimVerifierContext,
): Promise<readonly AtomicClaimVerification[]> {
  const results: AtomicClaimVerification[] = [];
  for (const c of claims) {
    const verifier = resolveAtomicClaimVerifier(c.type);
    const out = await verifier.verify(c, ctx);
    results.push(out);
  }
  return results;
}
