import { describe, it, expect } from 'vitest';
import { stableJsonStringify, hashStableJson } from '../stable-json.js';

describe('stableJsonStringify key ordering', () => {
  it('orders keys by code point, not by locale (accents/case)', () => {
    // Under a Unicode-aware locale collation (localeCompare), 'a' and 'A' and 'á'
    // would interleave differently than pure code-unit order. Code-point order
    // puts ASCII uppercase before lowercase, and accented letters after ASCII.
    const out = stableJsonStringify({ á: 1, a: 2, A: 3, b: 4, B: 5 });
    // Code-unit order: 'A'(65) 'B'(66) 'a'(97) 'b'(98) 'á'(225)
    expect(out).toBe('{"A":3,"B":5,"a":2,"b":4,"á":1}');
  });

  it('produces identical bytes regardless of input key insertion order', () => {
    const a = stableJsonStringify({ Über: 1, apple: 2, Æon: 3, '한글': 4 });
    const b = stableJsonStringify({ '한글': 4, apple: 2, Æon: 3, Über: 1 });
    expect(a).toBe(b);
  });

  it('orders Korean (한글) keys deterministically by code point', () => {
    const out = stableJsonStringify({ 나: 1, 가: 2, 다: 3 });
    // '가'(0xAC00) < '나'(0xB098) < '다'(0xB2E4)
    expect(out).toBe('{"가":2,"나":1,"다":3}');
  });

  it('hashStableJson is invariant to key insertion order', () => {
    const h1 = hashStableJson({ ä: 1, z: 2, A: 3, 가: 4 });
    const h2 = hashStableJson({ z: 2, 가: 4, A: 3, ä: 1 });
    expect(h1).toBe(h2);
  });
});

describe('stableJsonStringify regression — adjacent cases preserved', () => {
  it('handles empty object and empty array', () => {
    expect(stableJsonStringify({})).toBe('{}');
    expect(stableJsonStringify([])).toBe('[]');
  });

  it('preserves array order (no key sort applied to arrays)', () => {
    expect(stableJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('recursively sorts nested object keys', () => {
    expect(stableJsonStringify({ b: { y: 1, x: 2 }, a: 0 })).toBe('{"a":0,"b":{"x":2,"y":1}}');
  });

  it('passes primitives through unchanged', () => {
    expect(stableJsonStringify('héllo')).toBe('"héllo"');
    expect(stableJsonStringify(0)).toBe('0');
    expect(stableJsonStringify(null)).toBe('null');
  });
});
