import { describe, it, expect } from 'vitest';
import { canonicalJsonStringify } from '../canonical-json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys and drops undefined', () => {
    expect(canonicalJsonStringify({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}');
  });

  it('is stable for nested objects', () => {
    const a = canonicalJsonStringify({ x: { m: 1, n: 2 } });
    const b = canonicalJsonStringify({ x: { n: 2, m: 1 } });
    expect(a).toBe(b);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonStringify({ x: NaN })).toThrow(/Non-finite/);
  });
});
