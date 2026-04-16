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
