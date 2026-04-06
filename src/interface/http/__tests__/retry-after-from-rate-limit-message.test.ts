import { describe, expect, it } from 'vitest';
import { parseRetryAfterSecondsFromRateLimitMessage } from '../retry-after-from-rate-limit-message.js';

describe('parseRetryAfterSecondsFromRateLimitMessage', () => {
  it('parses minutes (typical @fastify/rate-limit wording)', () => {
    expect(
      parseRetryAfterSecondsFromRateLimitMessage(
        'Rate limit exceeded, retry in 1 minute',
      ),
    ).toBe(60);
    expect(
      parseRetryAfterSecondsFromRateLimitMessage('retry in 2 minutes please'),
    ).toBe(120);
  });

  it('parses seconds', () => {
    expect(
      parseRetryAfterSecondsFromRateLimitMessage('retry in 45 seconds'),
    ).toBe(45);
  });

  it('parses milliseconds (ceil to whole seconds, min 1)', () => {
    expect(
      parseRetryAfterSecondsFromRateLimitMessage('retry in 5000 ms'),
    ).toBe(5);
    expect(
      parseRetryAfterSecondsFromRateLimitMessage('retry in 500 ms'),
    ).toBe(1);
  });

  it('is case-insensitive for the unit keyword', () => {
    expect(
      parseRetryAfterSecondsFromRateLimitMessage('RETRY IN 1 MINUTE'),
    ).toBe(60);
  });

  it('defaults to 60 when no known pattern matches', () => {
    expect(parseRetryAfterSecondsFromRateLimitMessage('Rate limit exceeded')).toBe(
      60,
    );
    expect(parseRetryAfterSecondsFromRateLimitMessage('')).toBe(60);
  });
});
