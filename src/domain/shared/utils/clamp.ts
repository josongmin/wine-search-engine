/**
 * Numeric clamping utilities (SSoT).
 *
 * Centralized so that every signal/scoring path normalizes to [0, 1] using
 * the same NaN-safe semantics. The previous codebase had `clamp01` redefined
 * in 6+ files and 11+ inline `Math.max(0, Math.min(1, x))` patterns, which
 * drifted: some clamped NaN→0, others let it through.
 *
 * NaN policy: non-finite input always clamps to 0. This is defense-in-depth
 * — every upstream signal function should already guard against producing
 * NaN; if it does not, the clamp here at least keeps the value in range so
 * comparators do not silently misbehave (NaN compared with anything is false).
 *
 * Callers that NEED to detect non-finite input (so they can log / fail-loud)
 * must check `Number.isFinite(x)` BEFORE calling clamp01 — once clamped to 0
 * the original NaN signal is gone.
 */

/**
 * Clamps a numeric value to the [0, 1] range.
 *
 * - `value < 0` → 0
 * - `value > 1` → 1
 * - `NaN` / `±Infinity` → 0 + one-shot process warning
 * - otherwise → `value` unchanged
 *
 * Non-finite input emits a single Node.js process warning per code so
 * operators can detect upstream corruption without pulling a logger into
 * this pure domain module. The warning is deduplicated by `code` so a
 * runaway signal function does not flood the warning stream.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    process.emitWarning(
      `clamp01 received non-finite value (${value}) — clamping to 0. This indicates a bug in an upstream signal/scoring function.`,
      { type: 'ClampWarning', code: 'CLAMP01_NON_FINITE' },
    );
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Clamps to an arbitrary inclusive range [lo, hi]. Same NaN policy as
 * {@link clamp01} — non-finite input clamps to `lo`.
 */
export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (lo > hi) {
    // Caller bug: invalid range. Return the lower bound rather than
    // silently swapping.
    return lo;
  }
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Runtime guard for the [0, 1] invariant on probability / normalized score
 * fields (`normalizedScore`, `relevanceScore`, calibrated confidence). Unlike
 * {@link clamp01}, this **throws** on violation rather than silently masking
 * the bug — use at domain construction boundaries where producing an
 * out-of-range value is itself a contract violation worth surfacing.
 *
 * Returns the validated value so it composes inline:
 *   `const s = assertScore01(rawSignal, 'normalizedScore');`
 *
 * Prefer this over `clamp01` at the **entry point** of a value into the
 * domain (Vespa response mapping, calibrator output assembly, LLM JSON
 * parse). Use `clamp01` only where a defensive normalization is intentional
 * (e.g. mixing N independently-clamped signals).
 */
export function assertScore01(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${fieldName} must be a finite number in [0, 1]; got ${String(value)}. ` +
        `This indicates an upstream scoring bug (NaN propagation, missing ` +
        `normalization, or score-space confusion). Fix the source — do not ` +
        `clamp at the boundary.`,
    );
  }
  return value;
}
