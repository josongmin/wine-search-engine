/**
 * Wave 2 — typed cache operation results.
 *
 * Problem: prior contract conflated four distinct conditions under a single
 * `null` return value:
 *   - legitimate cache miss (entry genuinely absent)
 *   - circuit breaker open (infra degraded, don't hit Redis)
 *   - infra error (Redis connection, network, auth)
 *   - corrupt entry (present but failed schema validation)
 *
 * Callers downstream of the wrapper (search-usecase-cache-lookup, injection
 * judge, query/embedding caches) could not differentiate, so they treated
 * breaker-open / infra-error / corrupt as a benign miss and silently paid
 * the full compute cost without flagging the degradation.
 *
 * The discriminated unions below make those states first-class. Adapters
 * still expose convenience methods that collapse to `string | null` for
 * backwards compatibility, but the typed methods surface the real state.
 */

export type CacheGetResult<T> =
  | { readonly kind: 'hit'; readonly value: T }
  | { readonly kind: 'miss' }
  | { readonly kind: 'breaker_open' }
  | { readonly kind: 'infra_error'; readonly errorClass: string; readonly message: string }
  | { readonly kind: 'corrupt_entry'; readonly reason: string };

export type CacheWriteResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'breaker_open' }
  | { readonly kind: 'infra_error'; readonly errorClass: string; readonly message: string };

export function cacheHit<T>(value: T): CacheGetResult<T> {
  return { kind: 'hit', value };
}
export function cacheMiss<T>(): CacheGetResult<T> {
  return { kind: 'miss' };
}
export function cacheBreakerOpen<T>(): CacheGetResult<T> {
  return { kind: 'breaker_open' };
}
export function cacheInfraError<T>(err: unknown): CacheGetResult<T> {
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'infra_error', errorClass, message };
}
export function cacheCorruptEntry<T>(reason: string): CacheGetResult<T> {
  return { kind: 'corrupt_entry', reason };
}

export function writeOk(): CacheWriteResult {
  return { kind: 'ok' };
}
export function writeBreakerOpen(): CacheWriteResult {
  return { kind: 'breaker_open' };
}
export function writeInfraError(err: unknown): CacheWriteResult {
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'infra_error', errorClass, message };
}

/**
 * Convenience for callers that haven't migrated to the typed surface yet:
 * collapses any non-hit outcome to null. Use sparingly — prefer branching on
 * `kind` at observability-sensitive call sites (search pipeline, security).
 */
export function toLegacyGetValue<T>(result: CacheGetResult<T>): T | null {
  return result.kind === 'hit' ? result.value : null;
}
