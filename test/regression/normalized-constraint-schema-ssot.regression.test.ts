/**
 * SSoT regression: NormalizedConstraint Zod schema lives next to its
 * interface in `@shared/types/constraint-bundle-schema.ts`. The application
 * layer's `wine-search-schemas.ts` re-exports the same identity (strangler-fig
 * migration step).
 *
 * Locks the following invariants:
 *  - The domain schema parses a known-valid `NormalizedConstraint`.
 *  - The domain schema rejects an invalid instance (wrong operator).
 *  - Korean string values round-trip (no \b-style ASCII boundary bugs).
 *  - Boundary tests for the confidence range [0, 1] (CLAUDE.md rule 18:
 *    document and test the exact bound).
 *  - `wine-search-schemas.ts` re-exports the SAME schema identity — drift
 *    here would re-introduce the SSoT violation that motivated the move.
 *  - Schema output is structurally assignable to the `NormalizedConstraint`
 *    interface (compile-time check — file fails to typecheck if drift).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  NormalizedConstraintSchema,
  type NormalizedConstraint,
} from '@shared/types/index.js';
import { NormalizedConstraintSchema as NormalizedConstraintSchemaFromAppRefactor } from '../../src/domain/shared/types/constraint-bundle-schema.js';
import { NormalizedConstraintSchema as NormalizedConstraintSchemaFromAppLayer } from '../../src/application/wine-search/wine-search-schemas.js';

function validInstance(): NormalizedConstraint {
  return {
    attribute: 'region',
    operator: '=',
    value: 'Burgundy',
    source_phrase: 'Burgundy wine',
    confidence: 0.92,
  };
}

describe('NormalizedConstraintSchema — SSoT in @shared/types', () => {
  it('parses a known-valid NormalizedConstraint round-trip', () => {
    const result = NormalizedConstraintSchema.safeParse(validInstance());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attribute).toBe('region');
      expect(result.data.operator).toBe('=');
      expect(result.data.value).toBe('Burgundy');
      expect(result.data.confidence).toBe(0.92);
    }
  });

  it('rejects an invalid operator (closed enum)', () => {
    const bad = { ...validInstance(), operator: 'contains' };
    expect(NormalizedConstraintSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown extra keys (strict mode)', () => {
    const bad = { ...validInstance(), extra_field: 'oops' };
    expect(NormalizedConstraintSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a constraint with Korean attribute/value/source_phrase', () => {
    const koreanInstance: NormalizedConstraint = {
      attribute: '품종',
      operator: 'in',
      value: ['피노누아', '카베르네 소비뇽'],
      source_phrase: '피노누아 또는 카베르네 소비뇽',
      confidence: 0.87,
    };
    const result = NormalizedConstraintSchema.safeParse(koreanInstance);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toEqual(['피노누아', '카베르네 소비뇽']);
      expect(result.data.source_phrase).toBe('피노누아 또는 카베르네 소비뇽');
    }
  });

  it('accepts confidence at the lower bound (0)', () => {
    const atLower = { ...validInstance(), confidence: 0 };
    expect(NormalizedConstraintSchema.safeParse(atLower).success).toBe(true);
  });

  it('accepts confidence at the upper bound (1)', () => {
    const atUpper = { ...validInstance(), confidence: 1 };
    expect(NormalizedConstraintSchema.safeParse(atUpper).success).toBe(true);
  });

  it('rejects confidence just below the lower bound (-0.001)', () => {
    const belowLower = { ...validInstance(), confidence: -0.001 };
    expect(NormalizedConstraintSchema.safeParse(belowLower).success).toBe(false);
  });

  it('rejects confidence just above the upper bound (1.001)', () => {
    const aboveUpper = { ...validInstance(), confidence: 1.001 };
    expect(NormalizedConstraintSchema.safeParse(aboveUpper).success).toBe(false);
  });

  it('rejects NaN / Infinity in confidence (.finite() guard)', () => {
    const nanCase = { ...validInstance(), confidence: Number.NaN };
    const infCase = { ...validInstance(), confidence: Number.POSITIVE_INFINITY };
    expect(NormalizedConstraintSchema.safeParse(nanCase).success).toBe(false);
    expect(NormalizedConstraintSchema.safeParse(infCase).success).toBe(false);
  });

  it('accepts a range value with finite numeric bounds', () => {
    const rangeCase = {
      ...validInstance(),
      attribute: 'price',
      operator: 'range' as const,
      value: { min: 10, max: 50 },
    };
    expect(NormalizedConstraintSchema.safeParse(rangeCase).success).toBe(true);
  });

  it('rejects a range value containing NaN', () => {
    const badRange = {
      ...validInstance(),
      attribute: 'price',
      operator: 'range' as const,
      value: { min: Number.NaN, max: 50 },
    };
    expect(NormalizedConstraintSchema.safeParse(badRange).success).toBe(false);
  });

  it('accepts an optional mapping_version when present', () => {
    const withVersion = { ...validInstance(), mapping_version: 'rfc-004-v1' };
    expect(NormalizedConstraintSchema.safeParse(withVersion).success).toBe(true);
  });

  it('accepts a degenerate range where min === max (point range)', () => {
    // e.g. "exactly the 2015 vintage" → { min: 2015, max: 2015 }. The closed
    // interval [min, max] is non-empty when min === max, so this is valid.
    const pointRange = {
      ...validInstance(),
      attribute: 'vintage',
      operator: 'range' as const,
      value: { min: 2015, max: 2015 },
    };
    expect(NormalizedConstraintSchema.safeParse(pointRange).success).toBe(true);
  });

  it('rejects an inverted range where min > max (empty-set invariant)', () => {
    // min > max describes the empty set — always an emitter bug, never a
    // legitimate constraint. The .refine() invariant must fail closed.
    const invertedRange = {
      ...validInstance(),
      attribute: 'price',
      operator: 'range' as const,
      value: { min: 50, max: 10 },
    };
    expect(NormalizedConstraintSchema.safeParse(invertedRange).success).toBe(false);
  });

  it('rejects an inverted range just past the boundary (min one above max)', () => {
    // Boundary: min === max passes; min === max + 1 is the smallest inverted
    // range and must be rejected (off-by-one guard on the <= comparison).
    const justInverted = {
      ...validInstance(),
      attribute: 'vintage',
      operator: 'range' as const,
      value: { min: 2016, max: 2015 },
    };
    expect(NormalizedConstraintSchema.safeParse(justInverted).success).toBe(false);
  });
});

describe('NormalizedConstraintSchema — re-export identity (SSoT)', () => {
  it('the @shared/types barrel and the schema module export the SAME identity', () => {
    expect(NormalizedConstraintSchema).toBe(NormalizedConstraintSchemaFromAppRefactor);
  });

  it('the application-layer re-export resolves to the SAME identity (no shadow copy)', () => {
    expect(NormalizedConstraintSchemaFromAppLayer).toBe(NormalizedConstraintSchema);
  });
});

describe('NormalizedConstraintSchema — compile-time assignability', () => {
  it('schema output is structurally assignable to the domain interface', () => {
    // Compile-time invariant: if z.infer<typeof Schema> stops extending the
    // domain interface, this test file fails to typecheck. The runtime check
    // is just a smoke test that the parse path returns a value usable wherever
    // the interface is expected.
    const parsed = NormalizedConstraintSchema.parse(validInstance());
    const asInterface: NormalizedConstraint = parsed;
    expect(asInterface.attribute).toBe(parsed.attribute);
  });
});
