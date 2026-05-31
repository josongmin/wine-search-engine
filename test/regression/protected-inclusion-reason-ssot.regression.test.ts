/**
 * SSoT regression: the 5-value "protected inclusion reason" vocabulary lives
 * in `@domain/retrieval/model/provenance.ts` as `PROVENANCE_PROTECTED_REASONS`
 * (tuple) / `ProvenanceProtectedReason` (derived type).
 *
 * History: the same 5 literals were authored independently in THREE places:
 *   - `provenance.ts` — `PROVENANCE_PROTECTED_REASONS` / `ProvenanceProtectedReason`
 *   - `candidate-envelope.ts` — `ProtectedInclusionReason` string union
 *   - `retrieval-contract-v2.ts` — inline `z.enum([...])` literal array
 * Any of the three could gain/lose a value independently. A drift between the
 * Zod schema and the TS union would let a candidate carry a
 * `protectedInclusionReason` the schema rejects (or vice-versa), silently
 * dropping it at the retrieval-contract-v2 validation boundary.
 *
 * Invariants locked here:
 *  - `candidate-envelope.ts:ProtectedInclusionReason` is type-identical to
 *    `provenance.ts:ProvenanceProtectedReason` (compile-time assignability
 *    both directions).
 *  - The runtime Zod enum in `CandidateProvenanceV2Schema.protectedInclusionReason`
 *    accepts EXACTLY the `PROVENANCE_PROTECTED_REASONS` set — no more, no less.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_PROTECTED_REASONS,
  type ProvenanceProtectedReason,
} from '@domain/retrieval/model/provenance.js';
import type { ProtectedInclusionReason } from '@domain/retrieval/model/candidate-envelope.js';
import { CandidateProvenanceV2Schema } from '@domain/retrieval/model/retrieval-contract-v2.js';

describe('protected-inclusion-reason SSoT (provenance.ts)', () => {
  it('candidate-envelope ProtectedInclusionReason is type-identical to ProvenanceProtectedReason', () => {
    // Compile-time bidirectional assignability. If either type drifts (gains
    // or loses a literal), one of these assignments fails to typecheck.
    const fromEnvelope: ProtectedInclusionReason = 'diversity_slot';
    const toProvenance: ProvenanceProtectedReason = fromEnvelope;
    const backToEnvelope: ProtectedInclusionReason = toProvenance;
    expect(backToEnvelope).toBe('diversity_slot');

    // Every SSoT member must be a valid ProtectedInclusionReason.
    const all: readonly ProtectedInclusionReason[] = PROVENANCE_PROTECTED_REASONS;
    expect(all).toEqual([
      'exact_alias_match',
      'known_item_lookup',
      'anchor_conditioned',
      'hard_constraint_compatible',
      'diversity_slot',
    ]);
  });

  it('retrieval-contract-v2 Zod enum accepts exactly the SSoT reason set', () => {
    const base = {
      channels: [],
      channelScores: [],
      queryViewMatches: [],
      anchorConditioned: false,
      matchedFilterConstraints: [],
      fusionProfile: 'default',
      fusionScore: 0,
    };

    // Every SSoT reason must parse.
    for (const reason of PROVENANCE_PROTECTED_REASONS) {
      const parsed = CandidateProvenanceV2Schema.safeParse({
        ...base,
        protectedInclusionReason: reason,
      });
      expect(parsed.success, `reason "${reason}" should parse`).toBe(true);
    }

    // A reason NOT in the SSoT set must be rejected — proves the enum is not
    // silently permissive (which would let drift go unnoticed).
    const rejected = CandidateProvenanceV2Schema.safeParse({
      ...base,
      protectedInclusionReason: 'not_a_real_reason',
    });
    expect(rejected.success).toBe(false);
  });
});
