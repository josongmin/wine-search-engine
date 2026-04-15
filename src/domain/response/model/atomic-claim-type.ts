/**
 * ADR-016 Axis 3 — 9-class field-level `AtomicClaimType` taxonomy.
 *
 * This is a SEPARATE axis from RFC-020's 5-class `ClaimCategory`. Both
 * coexist on every emitted claim:
 *   - `type: AtomicClaimType` — what kind of value (9 classes).
 *   - `category: ClaimCategory` — how to verify (5 classes).
 *
 * The 9→5 default mapping is canonicalised in
 * {@link DEFAULT_TYPE_TO_CATEGORY_MAPPING}. Every emitted claim's
 * `(type, category)` pair MUST be a member of this table — enforced
 * by a Zod refine in `grounded-claim.ts`.
 */

import { z } from 'zod';
import type { ClaimCategory } from '../../evaluation/model/claim.js';

/** 9-class field-level claim type union. Closed; adding a member is
 *  a schema-breaking change that requires bumping
 *  `GROUNDED_CLAIM_SCHEMA_VERSION` and adding the 9→5 mapping. */
export const ATOMIC_CLAIM_TYPES = [
  'entity_reference',
  'attribute_assertion',
  'price_assertion',
  'vintage_assertion',
  'pairing_assertion',
  'comparative_assertion',
  'drinking_window_assertion',
  'style_assertion',
  'recommendation',
] as const;

export type AtomicClaimType = typeof ATOMIC_CLAIM_TYPES[number];

export const AtomicClaimTypeSchema = z.enum(ATOMIC_CLAIM_TYPES);

/**
 * Default 9→5 mapping. See ADR-016 §2.1.
 *
 * The table is closed. Any `(type, category)` pair outside this table
 * is rejected at schema validation — fail-closed keeps the two axes
 * from drifting silently.
 */
export const DEFAULT_TYPE_TO_CATEGORY_MAPPING: Readonly<
  Record<AtomicClaimType, ClaimCategory>
> = {
  entity_reference: 'identity_claim',
  attribute_assertion: 'derived_structured_claim',
  price_assertion: 'core_structured_claim',
  vintage_assertion: 'core_structured_claim',
  pairing_assertion: 'semantic_claim',
  comparative_assertion: 'comparative_claim',
  drinking_window_assertion: 'core_structured_claim',
  style_assertion: 'derived_structured_claim',
  recommendation: 'semantic_claim',
};
