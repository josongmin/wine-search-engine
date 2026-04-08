/**
 * Derive `Retry-After` (seconds) from @fastify/rate-limit-style messages, e.g.
 * "Rate limit exceeded, retry in 1 minute".
 */

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const RETRY_AFTER_FALLBACK_SECONDS = 60;
const RETRY_AFTER_MIN_SECONDS = 1;

export function parseRetryAfterSecondsFromRateLimitMessage(message: string): number {
  const minuteMatch = message.match(/retry in (\d+)\s*minute/i);
  if (minuteMatch?.[1] !== undefined) {
    const n = Number.parseInt(minuteMatch[1], 10);
    return Number.isFinite(n) ? n * SECONDS_PER_MINUTE : RETRY_AFTER_FALLBACK_SECONDS;
  }
  const secondMatch = message.match(/retry in (\d+)\s*second/i);
  if (secondMatch?.[1] !== undefined) {
    const n = Number.parseInt(secondMatch[1], 10);
    return Number.isFinite(n) ? n : RETRY_AFTER_FALLBACK_SECONDS;
  }
  const msMatch = message.match(/retry in (\d+)\s*ms/i);
  if (msMatch?.[1] !== undefined) {
    const n = Number.parseInt(msMatch[1], 10);
    return Number.isFinite(n)
      ? Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(n / MILLISECONDS_PER_SECOND))
      : RETRY_AFTER_FALLBACK_SECONDS;
  }
  return RETRY_AFTER_FALLBACK_SECONDS;
}
