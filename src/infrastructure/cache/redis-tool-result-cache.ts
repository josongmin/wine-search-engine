/**
 * RedisToolResultCache — driven-side adapter for `ToolResultCachePort`.
 *
 * Stores PtE wine-agent-loop tool outputs keyed by (toolName, sha256-16 of stable
 * stringified normalized input). Mirrors the `RedisEmbeddingCache` /
 * `RedisPhraseCache` patterns:
 *  - Uses {@link getRedisClient} (async — re-resolved on every op so a
 *    transient disconnect on the singleton path triggers a clean reconnect).
 *  - Fails OPEN on any infra failure: `get` returns null, `set` is a no-op,
 *    a warning is logged ONCE per process (no log-flood when Redis is down).
 *  - Validates the parsed JSON envelope with a strict Zod schema before
 *    returning a hit — protects against cache poisoning and schema drift.
 *  - Bounds the serialized payload to {@link MAX_TOOL_CACHE_PAYLOAD_BYTES}
 *    so a pathological tool response can never blow Redis memory.
 *
 * Out of scope (intentional): stats counters, scan/delete-by-pattern. The
 * wine-agent-loop cache is a HOT path (~p95 < 5ms) — keep the read path minimal.
 * Stats can be added later by mirroring `RedisCache.getValidatedWithStats`.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { stableStringify } from '../../domain/shared/utils/stable-stringify.js';
import { getRedisClient } from '../db/redis-client.js';
import type {
  ToolCacheKey,
  ToolResultCachePort,
  ToolResultRecord,
} from '../../application/wine-search/port/tool-result-cache.port.js';

const log = bootstrapLogger.child({ component: 'RedisToolResultCache' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key namespace for the tool result cache. Separate prefix from
 *  embedding/phrase/query caches so SCAN-by-pattern and ops dashboards can
 *  treat it independently. */
const REDIS_KEY_PREFIX = 'tool-result:';

/** SHA-256 hash truncation length (hex chars). 16 hex = 64 bits — collision
 *  probability of ~10⁻¹⁰ at 100K cached entries, well below the practical
 *  cache size in production. Matches the truncation pattern used elsewhere
 *  in the repo (e.g. anchor key hashing). */
const CACHE_KEY_HASH_HEX_CHARS = 16;

/** Hard cap on the serialized record size (bytes). Tool results larger than
 *  this are not cached — the hot path latency benefit disappears when each
 *  read parses a multi-MB blob. 1 MiB is well above the largest legitimate
 *  search response (top-5 preview ≈ a few KB). */
const MAX_TOOL_CACHE_PAYLOAD_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Validation schema (strict — internal data shape, not LLM output)
// ---------------------------------------------------------------------------

const ToolResultRecordSchema = z.object({
  // `unknown` rather than a refined shape — each tool returns a different
  // payload (search response, comparison response, drinkability probe …).
  // The wine-agent-loop downstream re-applies any per-tool typing.
  result: z.unknown(),
  // `createdAt` is a writer-side timestamp (Date.now()). `.finite()` rejects
  // NaN/Infinity which would otherwise pass `.number()`.
  createdAt: z.number().finite(),
}).strict();

// ---------------------------------------------------------------------------
// Input hash — uses the SSoT `stableStringify` so the hash is identical
// across application + infrastructure callers.
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic hash component of a `ToolCacheKey` from a
 * normalized input object. The output is a truncated SHA-256 hex string;
 * the same input on any machine produces the same hash.
 */
export function computeInputHash(input: unknown): string {
  const canonical = stableStringify(input);
  return createHash('sha256').update(canonical).digest('hex').slice(0, CACHE_KEY_HASH_HEX_CHARS);
}

function buildRedisKey(key: ToolCacheKey): string {
  return `${REDIS_KEY_PREFIX}${key.toolName}:${key.normalizedInputHash}`;
}

// ---------------------------------------------------------------------------
// Warn-once seam — keep log volume bounded under Redis outage.
// ---------------------------------------------------------------------------

let warnedGetFailure = false;
let warnedSetFailure = false;
let warnedParseFailure = false;
let warnedOversize = false;

function warnOnce(kind: 'get' | 'set' | 'parse' | 'oversize', payload: Record<string, unknown>, message: string): void {
  switch (kind) {
    case 'get':
      if (warnedGetFailure) return;
      warnedGetFailure = true;
      break;
    case 'set':
      if (warnedSetFailure) return;
      warnedSetFailure = true;
      break;
    case 'parse':
      if (warnedParseFailure) return;
      warnedParseFailure = true;
      break;
    case 'oversize':
      if (warnedOversize) return;
      warnedOversize = true;
      break;
  }
  log.warn(payload, message);
}

/**
 * Reset the warn-once latches. Test-only seam — production code never calls
 * this. Exposed because vitest preserves module state across tests in the
 * same file, and a stale latch from one test masks legitimate warnings in
 * the next.
 */
export function __resetRedisToolResultCacheWarnLatchesForTests(): void {
  warnedGetFailure = false;
  warnedSetFailure = false;
  warnedParseFailure = false;
  warnedOversize = false;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Redis-backed adapter for the tool-result cache. Construct with a resolver
 * that returns a connected Redis client (defaults to `getRedisClient`); tests
 * inject a mock.
 */
export class RedisToolResultCache implements ToolResultCachePort {
  private readonly resolveClient: () => Promise<{
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  }>;

  constructor(deps?: {
    readonly resolveClient?: () => Promise<{
      readonly get: (key: string) => Promise<string | null>;
      readonly set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
    }>;
  }) {
    this.resolveClient = deps?.resolveClient ?? (async () => getRedisClient());
  }

  async get(key: ToolCacheKey): Promise<ToolResultRecord | null> {
    const redisKey = buildRedisKey(key);
    let raw: string | null;
    try {
      const client = await this.resolveClient();
      raw = await client.get(redisKey);
    } catch (error) {
      warnOnce(
        'get',
        { err: error, key: redisKey },
        'tool-result cache get failed; failing open',
      );
      return null;
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      // CLAUDE.md schema-quality bar: JSON.parse returns `any`; assigning
      // to `unknown` narrows safely without a cast (the lint rule bans
      // `as` casts in infrastructure).
      parsed = JSON.parse(raw);
    } catch (err) {
      warnOnce(
        'parse',
        { key: redisKey, err },
        'tool-result cache parse failed; treating as miss',
      );
      return null;
    }
    const result = ToolResultRecordSchema.safeParse(parsed);
    if (!result.success) {
      warnOnce(
        'parse',
        { key: redisKey, issues: result.error.issues.slice(0, 3) },
        'tool-result cache shape mismatch; treating as miss',
      );
      return null;
    }
    // `z.unknown()` produces an OPTIONAL field in the inferred type
    // (Zod treats `unknown` as "may be undefined"), but the port contract
    // requires `result` to be present (the value can itself be undefined
    // semantically). Re-wrap into the canonical shape — the safeParse above
    // already guarantees the runtime shape includes a `result` key.
    return { result: result.data.result, createdAt: result.data.createdAt };
  }

  async set(key: ToolCacheKey, value: ToolResultRecord, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      // Defensive — a 0 / non-finite TTL means a bug in the caller's
      // resolution. Fail-open: don't write, but also don't throw.
      return;
    }
    // Pre-flight validation: catches programming errors (bad shape) before
    // we burn a Redis round trip.
    const validated = ToolResultRecordSchema.safeParse(value);
    if (!validated.success) {
      warnOnce(
        'set',
        { tool: key.toolName, issues: validated.error.issues.slice(0, 3) },
        'tool-result cache write rejected (shape validation failed)',
      );
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(validated.data);
    } catch (err) {
      warnOnce(
        'set',
        { tool: key.toolName, err },
        'tool-result cache serialize failed; skipping write',
      );
      return;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_CACHE_PAYLOAD_BYTES) {
      warnOnce(
        'oversize',
        { tool: key.toolName, bytes: Buffer.byteLength(serialized, 'utf8') },
        'tool-result cache write skipped: payload exceeds size cap',
      );
      return;
    }
    const redisKey = buildRedisKey(key);
    try {
      const client = await this.resolveClient();
      await client.set(redisKey, serialized, { EX: ttlSeconds });
    } catch (error) {
      warnOnce(
        'set',
        { err: error, key: redisKey },
        'tool-result cache set failed; failing open',
      );
    }
  }
}
