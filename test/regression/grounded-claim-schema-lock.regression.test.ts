/**
 * ADR-016 Axis 3 — schema-lock regression for the grounded claim
 * payload. Locks:
 *   - 9-class `AtomicClaimType` membership.
 *   - 5-class `ClaimCategory` coexists on every claim.
 *   - Per-claim `claimSchemaVersion` non-optional.
 *   - Envelope-level `claimSchemaVersion` optional but literal-only.
 *   - `.strict()` rejects extras.
 *   - `(type, category)` pair must be in the ADR-016 §2.1 mapping table.
 *
 * Append-only — never delete.
 */

import { describe, expect, it } from 'vitest';
import {
  AtomicClaimSchema,
  GroundedPayloadSchema,
  GROUNDED_CLAIM_SCHEMA_VERSION,
} from '../../src/domain/response/model/grounded-claim.js';
import {
  ATOMIC_CLAIM_TYPES,
  DEFAULT_TYPE_TO_CATEGORY_MAPPING,
} from '../../src/domain/response/model/atomic-claim-type.js';

describe('ADR-016 grounded-claim schema lock', () => {
  it('AtomicClaimType is the frozen 9-class tuple', () => {
    expect(ATOMIC_CLAIM_TYPES).toEqual([
      'entity_reference',
      'attribute_assertion',
      'price_assertion',
      'vintage_assertion',
      'pairing_assertion',
      'comparative_assertion',
      'drinking_window_assertion',
      'style_assertion',
      'recommendation',
    ]);
  });

  it('every AtomicClaimType has a 5-class ClaimCategory mapping', () => {
    for (const t of ATOMIC_CLAIM_TYPES) {
      expect(DEFAULT_TYPE_TO_CATEGORY_MAPPING[t]).toBeDefined();
    }
  });

  it('AtomicClaim accepts a canonical pair (vintage_assertion/core_structured_claim)', () => {
    const row = {
      id: 'c1',
      type: 'vintage_assertion' as const,
      category: 'core_structured_claim' as const,
      text: '2015',
      provenance: [{ toolCallId: 't1' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    };
    const parsed = AtomicClaimSchema.safeParse(row);
    expect(parsed.success).toBe(true);
  });

  it('AtomicClaim rejects a non-canonical (type, category) pair', () => {
    const row = {
      id: 'c2',
      type: 'vintage_assertion' as const,
      // Mapping table says vintage → core_structured_claim. Give it
      // semantic_claim to check the refine fires.
      category: 'semantic_claim' as const,
      text: '2015',
      provenance: [{ toolCallId: 't1' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    };
    const parsed = AtomicClaimSchema.safeParse(row);
    expect(parsed.success).toBe(false);
  });

  it('AtomicClaim requires per-claim claimSchemaVersion', () => {
    const row = {
      id: 'c3',
      type: 'entity_reference' as const,
      category: 'identity_claim' as const,
      text: 'Opus One',
      provenance: [{ toolCallId: 't1' }],
    };
    const parsed = AtomicClaimSchema.safeParse(row);
    expect(parsed.success).toBe(false);
  });

  it('AtomicClaim rejects extra properties (.strict)', () => {
    const row = {
      id: 'c4',
      type: 'entity_reference' as const,
      category: 'identity_claim' as const,
      text: 'Opus One',
      provenance: [{ toolCallId: 't1' }],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
      extraField: 'not allowed',
    };
    const parsed = AtomicClaimSchema.safeParse(row);
    expect(parsed.success).toBe(false);
  });

  it('GroundedPayload requires envelope claimSchemaVersion literal', () => {
    const payload = {
      proseSegments: [],
      claims: [],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    };
    const parsed = GroundedPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    // Wrong literal
    const bad = {
      proseSegments: [],
      claims: [],
      claimSchemaVersion: 'claim_schema_v2',
    };
    expect(GroundedPayloadSchema.safeParse(bad).success).toBe(false);
  });
});
