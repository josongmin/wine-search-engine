/**
 * Regression tests: exact_entity QueryClass value (RFC-017).
 *
 * Append-only — do NOT delete entries.
 */

import { describe, it, expect } from 'vitest';
import {
  QUERY_CLASSES,
  isQueryClass,
  type QueryClass,
} from '../../src/domain/shared/types/query-class.js';

describe('QueryClass: exact_entity', () => {
  it('QUERY_CLASSES contains exact_entity', () => {
    expect(QUERY_CLASSES).toContain('exact_entity');
  });

  it('isQueryClass guard accepts exact_entity', () => {
    expect(isQueryClass('exact_entity')).toBe(true);
  });

  it('exact_entity is distinct from short_entity', () => {
    const a: QueryClass = 'exact_entity';
    const b: QueryClass = 'short_entity';
    expect(a).not.toBe(b);
  });

  it('isQueryClass still accepts all pre-existing QueryClass values', () => {
    const existing: QueryClass[] = [
      'short_entity',
      'ambiguous_short_form',
      'anchored_similarity',
      'pure_constraint',
      'semantic_preference',
      'comparison_query',
      'unknown',
    ];
    for (const qc of existing) {
      expect(isQueryClass(qc)).toBe(true);
    }
  });

  it('isQueryClass rejects unknown strings', () => {
    expect(isQueryClass('not_a_class')).toBe(false);
    expect(isQueryClass('')).toBe(false);
    expect(isQueryClass('EXACT_ENTITY')).toBe(false);
  });

  it('type-level: exact_entity is assignable to QueryClass', () => {
    // Compile-time assertion — if this compiles, the type is correct.
    const qc: QueryClass = 'exact_entity';
    expect(qc).toBe('exact_entity');
  });
});
