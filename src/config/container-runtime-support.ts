import type { Config } from './env.js';
import { bootstrapLogger } from './bootstrap-logger.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { LLMInjectionJudge } from '../domain/security/service/llm-injection-judge.js';
import type { InjectionJudgePort } from '../domain/security/port/injection-judge.port.js';
import type { JudgmentCachePort } from '../domain/security/port/judgment-cache.port.js';
import { AnthropicLLMInjectionClassifier } from '../infrastructure/adapter/anthropic-llm-injection-classifier.js';
import { CacheService } from '../domain/performance/index.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';
import type { RedisClient } from '../infrastructure/db/redis-client.js';
import { RedisQueryCache } from '../infrastructure/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '../infrastructure/cache/redis-embedding-cache.js';
import { RedisPhraseCache } from '../infrastructure/cache/redis-phrase-cache.js';
import type { PhraseCachePort } from '../domain/attribute/port/phrase-cache.port.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';

class RedisJudgmentCacheAdapter implements JudgmentCachePort {
  constructor(
    private readonly redis: RedisClient,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.redis.setEx(key, ttlSeconds, value);
  }
}

class InMemoryJudgmentCacheAdapter implements JudgmentCachePort {
  private static readonly MAX_ENTRIES = 2_000;
  // Map iteration is insertion-order; we manually re-insert on access to
  // implement true LRU semantics (delete-then-set moves the entry to the tail).
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return Promise.resolve(null);
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    // LRU: refresh recency by reinserting at the tail.
    this.store.delete(key);
    this.store.set(key, entry);
    return Promise.resolve(entry.value);
  }

  setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    // Always remove existing entry first so updates also refresh recency.
    this.store.delete(key);
    // Evict oldest entry when at capacity.
    if (this.store.size >= InMemoryJudgmentCacheAdapter.MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }
}

export interface RuntimeSupportServices {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly phraseCache?: PhraseCachePort | undefined;
}

export async function buildRuntimeSupportServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<RuntimeSupportServices> {
  const querySanitizer = new QuerySanitizer();
  const { pool, redisClient } = runtime;

  let injectionJudge: InjectionJudgePort | undefined;
  if (config.anthropic.apiKey && !config.killSwitch.injectionJudge) {
    injectionJudge = new LLMInjectionJudge(
      new AnthropicLLMInjectionClassifier(config.anthropic.apiKey, {
        model: config.anthropic.injectionModel,
      }),
      redisClient
        ? new RedisJudgmentCacheAdapter(redisClient)
        : new InMemoryJudgmentCacheAdapter(),
    );
    bootstrapLogger.info(
      { model: config.anthropic.injectionModel, cache: redisClient ? 'redis' : 'memory' },
      '[Container] LLM injection judge (Layer 2) enabled',
    );
    if (!redisClient) {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; using in-memory cache for LLMInjectionJudge',
      );
    }
  } else if (!config.killSwitch.injectionJudge) {
    // Loud warning: Layer 2 prompt-injection defense is silently disabled
    // because ANTHROPIC_API_KEY is unset. Production env validation throws
    // for this combination (env.ts) but dev/test silently skip — historically
    // this hid the SQL injection bypass that the SOTA++ benchmark caught.
    // The warning makes the gap visible at boot.
    bootstrapLogger.warn(
      {
        nodeEnv: config.nodeEnv,
        killSwitchInjectionJudge: config.killSwitch.injectionJudge,
      },
      '[SECURITY] Layer 2 LLM injection judge DISABLED — '
      + 'ANTHROPIC_API_KEY is unset. Layer 1 sanitizer is the only line of defense. '
      + 'Set ANTHROPIC_API_KEY or KILL_SWITCH_INJECTION_JUDGE=true to silence this warning.',
    );
  }

  let cacheService: CacheService | undefined;
  if (!config.killSwitch.queryCache) {
    if (redisClient) {
      cacheService = new CacheService(
        new RedisQueryCache(redisClient),
        new RedisEmbeddingCache(redisClient),
        5,
        60000,
      );
      bootstrapLogger.info('[Container] Cache infrastructure initialized');
    } else {
      bootstrapLogger.warn(
        '[Container] Redis unavailable; continuing without cache infrastructure',
      );
    }
  }

  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool) {
    const ltrRegistry = new PgLtrModelRegistry(pool);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ltrModels = await ltrRegistry.getAllModels();
        if (ltrModels.size > 0) {
          bootstrapLogger.info(
            { ltrModelCount: ltrModels.size },
            '[Container] Loaded LTR models from registry',
          );
        } else {
          bootstrapLogger.warn('[Container] No LTR models found in registry');
        }
        break; // success
      } catch (err) {
        bootstrapLogger.error(
          { err, attempt },
          '[Container] LTR model load failed',
        );
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  const allowHeuristicFallback =
    config.nodeEnv !== 'production' || config.drinkingWindow.allowHeuristicInProduction;

  const drinkingWindowPredictor = new DrinkingWindowPredictor({ allowHeuristicFallback });
  if (config.drinkingWindow.modelDir !== undefined) {
    await drinkingWindowPredictor.load(config.drinkingWindow.modelDir);
    bootstrapLogger.info(
      { modelVersion: drinkingWindowPredictor.modelVersion },
      '[Container] Drinking-window predictor loaded',
    );
  }
  if (
    config.nodeEnv === 'production'
    && drinkingWindowPredictor.modelVersion.startsWith('heuristic')
    && !config.drinkingWindow.allowHeuristicInProduction
  ) {
    throw new Error(
      'Production startup refuses heuristic-only drinking-window prediction. Set ALLOW_HEURISTIC_DRINKING_WINDOW=true only with explicit approval.',
    );
  }

  // Phrase cache for LlmNLMapper. Optional: when Redis is unavailable we
  // simply pay the LLM cost on every miss instead of using a Map (which would
  // not survive process restarts and would not be shared across replicas).
  let phraseCache: PhraseCachePort | undefined;
  if (config.openai.llmQueryInterpreter) {
    if (redisClient) {
      phraseCache = new RedisPhraseCache(redisClient);
      bootstrapLogger.info('[Container] LLM phrase cache (Redis) enabled');
    } else {
      bootstrapLogger.warn(
        '[Container] LLM_QUERY_INTERPRETER=true but Redis is unavailable — phrase cache disabled, every miss will pay the full LLM cost',
      );
    }
  }

  return {
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels,
    drinkingWindowPredictor,
    ...(phraseCache !== undefined ? { phraseCache } : {}),
  };
}
