import { describe, expect, it } from 'vitest';
import { normalizeConstraintComparableString } from '../constraint-ontology-normalization.js';

describe('normalizeConstraintComparableString', () => {
  it('canonicalizes pairing surface variants onto the shared taxonomy tag', () => {
    expect(normalizeConstraintComparableString('pairing', 'steak')).toBe('beef');
    expect(normalizeConstraintComparableString('pairing', 'wagyu beef')).toBe('beef');
    expect(normalizeConstraintComparableString('pairing', 'braised beef')).toBe('beef');
  });
});
