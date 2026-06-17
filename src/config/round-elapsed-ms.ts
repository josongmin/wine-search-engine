/** Rounds a performance timer delta to millisecond precision without parseFloat/Number coercion. */
export function roundElapsedMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}
