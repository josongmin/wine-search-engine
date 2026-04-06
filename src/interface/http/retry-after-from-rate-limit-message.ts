/**
 * Derive `Retry-After` (seconds) from @fastify/rate-limit-style messages, e.g.
 * "Rate limit exceeded, retry in 1 minute".
 */
export function parseRetryAfterSecondsFromRateLimitMessage(message: string): number {
  const minuteMatch = message.match(/retry in (\d+)\s*minute/i);
  if (minuteMatch?.[1] !== undefined) {
    const n = Number.parseInt(minuteMatch[1], 10);
    return Number.isFinite(n) ? n * 60 : 60;
  }
  const secondMatch = message.match(/retry in (\d+)\s*second/i);
  if (secondMatch?.[1] !== undefined) {
    const n = Number.parseInt(secondMatch[1], 10);
    return Number.isFinite(n) ? n : 60;
  }
  const msMatch = message.match(/retry in (\d+)\s*ms/i);
  if (msMatch?.[1] !== undefined) {
    const n = Number.parseInt(msMatch[1], 10);
    return Number.isFinite(n) ? Math.max(1, Math.ceil(n / 1000)) : 60;
  }
  return 60;
}
