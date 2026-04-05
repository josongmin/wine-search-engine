import type { Pool } from 'pg';
import type { Config } from './env.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { LLMInjectionJudge } from '../domain/security/service/llm-injection-judge.js';
import { CacheService } from '../domain/performance/index.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';
import { getRedisClient } from '../infrastructure/db/redis-client.js';
import { RedisQueryCache } from '../infrastructure/cache/redis-query-cache.js';
import { RedisEmbeddingCache } from '../infrastructure/cache/redis-embedding-cache.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { DrinkingWindowPredictorContract } from './container-contracts.js';

export interface RuntimeSupportServices {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: LLMInjectionJudge | undefined;
  readonly cacheService?: CacheService | undefined;
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorContract;
}

export async function buildRuntimeSupportServices(
  config: Config,
  pool?: Pool,
): Promise<RuntimeSupportServices> {
  const querySanitizer = new QuerySanitizer();

  let injectionJudge: LLMInjectionJudge | undefined;
  if (config.anthropic.apiKey && !config.killSwitch.injectionJudge) {
    try {
      injectionJudge = new LLMInjectionJudge(config.anthropic.apiKey, await getRedisClient());
    } catch (err) {
      console.error('[Container] Failed to initialize LLMInjectionJudge:', err);
    }
  }

  let cacheService: CacheService | undefined;
  if (!config.killSwitch.queryCache) {
    try {
      const redisClient = await getRedisClient();
      cacheService = new CacheService(
        new RedisQueryCache(redisClient),
        new RedisEmbeddingCache(redisClient),
        5,
        60000,
      );
      console.warn('[Container] Cache infrastructure initialized');
    } catch (err) {
      console.warn('[Container] Failed to initialize caches; continuing without:', err);
    }
  }

  let ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined;
  if (pool) {
    const ltrRegistry = new PgLtrModelRegistry(pool);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ltrModels = await ltrRegistry.getAllModels();
        if (ltrModels.size > 0) {
          console.warn(`[Container] Loaded ${ltrModels.size} LTR models from registry`);
        } else {
          console.warn('[Container] No LTR models found in registry');
        }
        break; // success
      } catch (err) {
        console.error(`[Container] LTR model load attempt ${attempt}/2 failed:`, err);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  return {
    querySanitizer,
    injectionJudge,
    cacheService,
    ltrModels,
    drinkingWindowPredictor: new DrinkingWindowPredictor(),
  };
}
