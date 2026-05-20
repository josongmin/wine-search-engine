/**
 * Regression: constraint dedup keys must be order-independent for object values.
 *
 * Bug (Bugbash 2026-04-10 Round 18 / determinism):
 *   `keyOf(c)` used `JSON.stringify(c.value)` directly. For range constraints
 *   `{min, max}` vs `{max, min}` produced different keys, so two semantically
 *   identical constraints would not dedupe — propagating duplicate
 *   inferred/expanded constraints downstream and inflating the candidate
 *   penalty count.
 *
 * Fix: switch to `canonicalJsonStringify` from `@domain/shared/utils/canonical-json.ts`,
 *   which sorts object keys lexicographically before serialization.
 *
 * Append-only.
 */

import { describe, it, expect } from 'vitest';
import { canonicalJsonStringify } from '../../src/domain/shared/utils/canonical-json.js';

describe('constraint key determinism — bugbash R18', () => {
  it('canonicalJsonStringify produces the same output regardless of object key order', () => {
    const a = canonicalJsonStringify({ min: 2010, max: 2020 });
    const b = canonicalJsonStringify({ max: 2020, min: 2010 });
    expect(a).toBe(b);
  });

  it('canonicalJsonStringify is stable across nested object key shuffles', () => {
    const a = canonicalJsonStringify({ outer: { x: 1, y: 2 }, name: 'r' });
    const b = canonicalJsonStringify({ name: 'r', outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order (arrays are sequence-significant, not key-significant)', () => {
    const a = canonicalJsonStringify(['b', 'a']);
    const b = canonicalJsonStringify(['a', 'b']);
    expect(a).not.toBe(b);
  });

  it('drops undefined keys but preserves null', () => {
    const out = canonicalJsonStringify({ a: 1, b: undefined, c: null });
    expect(out).toBe('{"a":1,"c":null}');
  });
});
