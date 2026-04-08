/**
 * Human-readable duration strings for benchmark CLI output (deterministic; no locale).
 */

/** Below this, print durations as integer ms instead of seconds. */
const BENCHMARK_DURATION_MS_SHORT_MAX = 1_000;
/** Seconds per minute for human-readable duration lines. */
const BENCHMARK_SECONDS_PER_MINUTE = 60;
/** Milliseconds per second. */
const BENCHMARK_MS_PER_SECOND = 1_000;

export function formatBenchmarkDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < BENCHMARK_DURATION_MS_SHORT_MAX) {
    return `${Math.round(ms)}ms`;
  }
  const sec = ms / BENCHMARK_MS_PER_SECOND;
  if (sec < BENCHMARK_SECONDS_PER_MINUTE) {
    return `${sec.toFixed(1)}s`;
  }
  const wholeMin = Math.floor(sec / BENCHMARK_SECONDS_PER_MINUTE);
  const remSec = sec - wholeMin * BENCHMARK_SECONDS_PER_MINUTE;
  return `${wholeMin}m ${remSec.toFixed(0)}s`;
}
