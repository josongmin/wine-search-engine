/**
 * ToolResultCachePort — driven-side port for memoizing PtE mini-loop tool
 * dispatches.
 *
 * Identical `(toolName, normalizedInput)` invocations re-execute the entire
 * downstream pipeline (Vespa retrieval, PG queries, etc.). This port lets
 * the mini-loop short-circuit the second-and-onward call with a cache hit.
 *
 * Design rules:
 *  - Port lives in `application/` (the consumer-owned namespace) so the
 *    domain layer is unaffected.
 *  - Adapter side (Redis) lives in `infrastructure/`; tests inject a
 *    deterministic mock instead.
 *  - Fail-open contract: any infra failure on the adapter side MUST surface
 *    as `null` (for get) or a no-op (for set); the cache MUST NOT throw into
 *    the mini-loop. The caller never sees Redis errors.
 *  - TTLs are sourced from the per-tool SSoT in
 *    `@shared/constants/tool-cache-ttl.js`; callers pass the resolved value
 *    explicitly so the port surface stays tool-agnostic.
 */

/**
 * Stable, content-addressed cache key. The hash MUST be a deterministic
 * function of (toolName, normalized input) — adapters compute it with a
 * stable JSON stringify + SHA-256 truncated hex.
 */
export interface ToolCacheKey {
  readonly toolName: string;
  readonly normalizedInputHash: string;
}

/**
 * Cache record envelope. `result` is the per-tool result shape (search
 * response, comparison response, drinkability probe, …) stored as JSON.
 * `createdAt` is the producer-side timestamp at write time (Date.now()),
 * exposed for observability and stale-entry diagnostics; TTL is enforced by
 * the adapter (Redis EX), not by readers.
 */
export interface ToolResultRecord {
  readonly result: unknown;
  readonly createdAt: number;
}

export interface ToolResultCachePort {
  /**
   * Returns the cached record on hit, `null` on miss / corrupt entry /
   * infra error. MUST NOT throw — fail-open is required by the mini-loop's
   * pre-flight check contract.
   */
  get(key: ToolCacheKey): Promise<ToolResultRecord | null>;

  /**
   * Writes the record with an explicit per-tool TTL (in seconds). MUST NOT
   * throw — fail-open is required so a Redis outage cannot poison the
   * request path. Adapters MAY skip the write (e.g. payload over a hard
   * size cap) and SHOULD log a warning when they do.
   */
  set(key: ToolCacheKey, value: ToolResultRecord, ttlSeconds: number): Promise<void>;
}
