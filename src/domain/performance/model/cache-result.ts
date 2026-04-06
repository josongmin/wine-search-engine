/**
 * Result of a cache lookup — lives in the domain model layer so ports do not
 * depend on service implementations (avoids circular imports with CacheService).
 */
export interface CacheResult<T> {
  readonly hit: boolean;
  readonly data?: T;
  readonly reason?: string;
  readonly durationMs: number;
  readonly isStale?: boolean;
}
