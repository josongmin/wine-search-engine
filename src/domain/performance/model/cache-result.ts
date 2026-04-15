/**
 * Wave 2 — typed cache operation results.
 *
 * This mirrors the infrastructure cache-result union so domain ports can
 * surface the same discriminated states without depending on adapter code.
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

export type CacheDeleteResult = CacheWriteResult;

/**
 * Backwards-compatible alias retained for legacy imports while callers
 * migrate to the typed `CacheGetResult` name.
 */
export type CacheResult<T> = CacheGetResult<T>;

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
 * `kind` at observability-sensitive call sites.
 */
export function toLegacyGetValue<T>(result: CacheGetResult<T>): T | null {
  return result.kind === 'hit' ? result.value : null;
}
