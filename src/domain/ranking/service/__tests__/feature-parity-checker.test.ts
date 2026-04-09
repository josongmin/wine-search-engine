import { describe, it, expect } from 'vitest';
import { checkFeatureParity, FeatureParityCheckError } from '../feature-parity-checker.js';
import { getCurrentFeatureSchemaHash } from '../feature-parity-hash.js';

describe('checkFeatureParity', () => {
  it('returns match=true with skip reason when no expectedHash provided', () => {
    const result = checkFeatureParity({});
    expect(result.match).toBe(true);
    expect(result.expectedHash).toBeUndefined();
    expect(result.reason).toContain('skipped');
  });

  it('returns match=true when expectedHash matches current schema', () => {
    const current = getCurrentFeatureSchemaHash();
    const result = checkFeatureParity({ expectedHash: current });
    expect(result.match).toBe(true);
    expect(result.currentHash).toBe(current);
  });

  it('returns match=false with drift reason when hashes differ', () => {
    const result = checkFeatureParity({ expectedHash: 'deadbeef00000000' });
    expect(result.match).toBe(false);
    expect(result.reason).toContain('drift');
  });

  it('strict=true throws FeatureParityCheckError on mismatch', () => {
    expect(() => checkFeatureParity({ expectedHash: 'deadbeef00000000', strict: true }))
      .toThrowError(FeatureParityCheckError);
  });

  it('strict=true does NOT throw on match', () => {
    const current = getCurrentFeatureSchemaHash();
    expect(() => checkFeatureParity({ expectedHash: current, strict: true })).not.toThrow();
  });

  it('FeatureParityCheckError carries the result object', () => {
    try {
      checkFeatureParity({ expectedHash: 'deadbeef00000000', strict: true });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureParityCheckError);
      expect((err as FeatureParityCheckError).result.match).toBe(false);
      expect((err as FeatureParityCheckError).result.expectedHash).toBe('deadbeef00000000');
    }
  });
});
