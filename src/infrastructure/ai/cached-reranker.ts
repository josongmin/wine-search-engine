import { z } from 'zod';
import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../domain/ranking/port/reranker.port.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import { createEntityId, isCanonicalPublicEntityId } from '../../domain/shared/types/index.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'CachedReranker' });

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1_000;
const HOURS_PER_DAY = 24;
const RERANK_CACHE_TTL_SECONDS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const RERANK_CACHE_MAX_ENTRIES = 1_000;
const RERANK_CACHE_KEY_PREFIX = 'rerank:exact:';
const STATS_KEY_HITS = 'cache:stats:rerank:hits';
const STATS_KEY_MISSES = 'cache:stats:rerank:misses';
const CACHED_RERANK_RESULTS_SIZE_LIMIT = 256;

const CachedRerankResultSchema = z.object({
  entityId: z.string().min(1),
  score: z.number().finite(),
  rank: z.number().int().positive(),
}).strict();

const CachedRerankResultsSchema = z.array(CachedRerankResultSchema).max(
  CACHED_RERANK_RESULTS_SIZE_LIMIT,
);
const CACHE_TTL_SECONDS = RERANK_CACHE_TTL_SECONDS;

interface RerankCacheStore {
  get(key: string): Promise<readonly RerankResult[] | undefined>;
  set(key: string, value: readonly RerankResult[]): Promise<void>;
}

class InMemoryRerankCacheStore implements RerankCacheStore {
  private readonly store = new Map<string, { readonly value: readonly RerankResult[]; readonly expiresAt: number }>();

  get(key: string): Promise<readonly RerankResult[] | undefined> {
    this.pruneExpired();
    const entry = this.store.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(undefined);
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return Promise.resolve(entry.value);
  }

  set(key: string, value: readonly RerankResult[]): Promise<void> {
    this.pruneExpired();
    this.store.delete(key);
    if (this.store.size >= RERANK_CACHE_MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (RERANK_CACHE_TTL_SECONDS * MILLIS_PER_SECOND),
    });
    return Promise.resolve();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

class RedisRerankCacheStore implements RerankCacheStore {
  private readonly cache: RedisCache;

  constructor(redis: RedisClient) {
    this.cache = new RedisCache(redis, 0);
  }

  async get(key: string): Promise<readonly RerankResult[] | undefined> {
    const value = await this.cache.getValidatedWithStats(
      key,
      CachedRerankResultsSchema,
      {
        statsKeyHits: STATS_KEY_HITS,
        statsKeyMisses: STATS_KEY_MISSES,
        logComponent: 'RedisRerankCache',
      },
    );
    if (value === null) {
      return undefined;
    }
    const valid = value.every((item) => isCanonicalPublicEntityId(item.entityId));
    if (!valid) {
      return undefined;
    }
    return value.map((item) => ({
      entityId: createEntityId(item.entityId),
      score: item.score,
      rank: item.rank,
    }));
  }

  async set(key: string, value: readonly RerankResult[]): Promise<void> {
    await this.cache.setValidated(
      key,
      value,
      CachedRerankResultsSchema,
      'RedisRerankCache',
      CACHE_TTL_SECONDS,
    );
  }
}

interface CachedRerankerOptions {
  readonly modelId: string;
  readonly inner: RerankerPort;
  readonly redis?: RedisClient | undefined;
}

function buildCacheKey(
  modelId: string,
  query: string,
  limit: number,
  candidates: readonly RerankCandidate[],
): string {
  return `${RERANK_CACHE_KEY_PREFIX}${deterministicHash(
    modelId,
    query,
    limit,
    candidates.map((candidate) => ({
      entityId: candidate.entityId,
      text: candidate.text,
    })),
  )}`;
}

export class CachedReranker implements RerankerPort {
  readonly modelId: string;
  private readonly cacheStore: RerankCacheStore;

  constructor(
    private readonly options: CachedRerankerOptions,
  ) {
    this.modelId = options.modelId;
    this.cacheStore = options.redis !== undefined
      ? new RedisRerankCacheStore(options.redis)
      : new InMemoryRerankCacheStore();
  }

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<readonly RerankResult[]> {
    if (candidates.length === 0 || limit <= 0) {
      return [];
    }

    const cacheKey = buildCacheKey(this.options.modelId, query, limit, candidates);
    const cached = await this.cacheStore.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const results = await this.options.inner.rerank(query, candidates, limit);
    try {
      await this.cacheStore.set(cacheKey, results);
    } catch (err) {
      log.warn({ err, modelId: this.options.modelId }, 'rerank cache write failed; continuing uncached');
    }
    return results;
  }
}
