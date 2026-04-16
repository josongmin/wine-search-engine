import { describe, expect, it } from 'vitest';
import { resolveIncomingRequestId } from '../request-id.js';
import { canonicalizeRequestIdForHeader } from '../../../domain/shared/utils/request-id.js';

describe('resolveIncomingRequestId', () => {
  it('prefers a valid X-Request-Id', () => {
    const id = resolveIncomingRequestId({
      'x-request-id': 'edge-abc-123',
    });
    expect(id).toBe('edge-abc-123');
  });

  it('falls back to X-Correlation-Id when X-Request-Id is absent', () => {
    const id = resolveIncomingRequestId({
      'x-correlation-id': 'corr-xyz',
    });
    expect(id).toBe('corr-xyz');
  });

  it('ignores oversized ids and generates a new one', () => {
    const long = 'a'.repeat(200);
    const id = resolveIncomingRequestId({
      'x-request-id': long,
    });
    expect(id).not.toBe(long);
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('ignores ids with invalid characters', () => {
    const id = resolveIncomingRequestId({
      'x-request-id': 'bad\ninjection',
    });
    expect(id).not.toContain('\n');
  });
});

describe('canonicalizeRequestIdForHeader', () => {
  it('preserves a valid ASCII-safe request id exactly', () => {
    expect(canonicalizeRequestIdForHeader('edge-abc-123')).toBe('edge-abc-123');
  });

  it('canonicalizes Hangul-bearing request ids into bounded ASCII-only values deterministically', () => {
    const original = 'probe-피노 그리지오 추천';
    const canonical = canonicalizeRequestIdForHeader(original);

    expect(canonical).not.toBe(original);
    expect(canonical).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(canonical.length).toBeLessThanOrEqual(128);
    expect(canonicalizeRequestIdForHeader(original)).toBe(canonical);
  });
});
