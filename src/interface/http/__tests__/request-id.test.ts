import { describe, expect, it } from 'vitest';
import { resolveIncomingRequestId } from '../request-id.js';

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
