import type { RerankerFailureReason } from '../model/ranking-runtime-signal.js';

export function classifyRerankerFailureReason(error: unknown): RerankerFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('http')) return 'http_error';
  if (message.includes('unexpected response shape')) return 'parse_error';
  return 'unknown';
}
