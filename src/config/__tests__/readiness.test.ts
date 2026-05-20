import { describe, expect, it } from 'vitest';
import { buildHealthRouteOptions } from '../readiness.js';
import { parseEnv } from '../env.js';
import { globalSilentSkipCounter } from '../../domain/observability/silent-skip-counters.js';

describe('buildHealthRouteOptions', () => {
  it('marks redis as required when startup features need it, even without watchlist delivery', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      KILL_SWITCH_QUERY_CACHE: 'false',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.redis).toBeDefined();
    expect(health.readiness?.redis?.required).toBe(true);
    expect(health.readiness?.watchlist_runtime).toBeUndefined();
  });

  it('marks redis as required for the default OpenAI injection judge cache when configured', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'false',
      OPENAI_API_KEY: 'sk-test',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(config.queryEntrySecurity.injectionProvider).toBe('openai');
    expect(health.readiness?.redis).toBeDefined();
    expect(health.readiness?.redis?.required).toBe(true);
    expect(health.readiness?.watchlist_runtime).toBeUndefined();
  });

  it('marks redis as required when watchlist delivery is enabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      WATCHLIST_ENABLED: 'true',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const health = buildHealthRouteOptions(config, {}, {
      isRunning: () => true,
      start: async () => {},
      stop: async () => {},
    });

    expect(health.readiness?.redis).toBeDefined();
    expect(health.readiness?.redis?.required).toBe(true);
    expect(health.readiness?.watchlist_runtime).toBeDefined();
    expect(health.readiness?.watchlist_runtime?.required).toBe(true);
  });

  it('does not register a redis readiness check when no redis-backed features are enabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.redis).toBeUndefined();
    expect(health.readiness?.watchlist_runtime).toBeUndefined();
  });

  it('registers learned matcher readiness when the service is configured', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LEARNED_MATCHER_SERVICE_URL: 'http://localhost:8090',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.learned_matcher).toBeDefined();
    expect(health.readiness?.learned_matcher?.required).toBe(false);
  });

  it('treats deterministic drinking-window models as an available readiness substrate', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, undefined, {
      modelVersion: 'deterministic:structural-slot-v2',
      predict: () => ({
        drinkingWindowStart: 2020,
        drinkingWindowEnd: 2030,
        peakYear: 2025,
        confidence: 'medium',
        modelVersion: 'deterministic:structural-slot-v2',
      }),
    });

    expect(health.readiness?.drinking_window_model).toBeDefined();
    expect(health.readiness?.drinking_window_model?.required).toBe(false);
    expect(health.readiness?.drinking_window_model?.check?.()).toBe('up');
  });

  it('surfaces blocker zero-candidate events as a non-required degraded check', async () => {
    globalSilentSkipCounter.reset();
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.blocking_zero_candidates).toBeDefined();
    expect(health.readiness?.blocking_zero_candidates?.required).toBe(false);
    expect(health.readiness?.blocking_zero_candidates?.check()).toBe('up');

    globalSilentSkipCounter.increment('blocker_zero_candidates');
    expect(health.readiness?.blocking_zero_candidates?.check()).toBe('down');
    globalSilentSkipCounter.reset();
  });

  it('surfaces the effective serving LTR model state instead of only probing artifact readability', async () => {
    const config = parseEnv({ NODE_ENV: 'test' });

    const health = buildHealthRouteOptions(
      config,
      {},
      undefined,
      undefined,
      undefined,
      {
        drinkingWindowPredictor: {
          configured: true,
          loaded: true,
          modelVersion: 'deterministic:structural-slot-v2',
        },
        runtimeLtrArtifact: {
          configured: false,
          loaded: false,
          issue: 'disabled',
        },
        ltrModels: {
          registry: {
            configured: false,
            loaded: false,
            issue: 'disabled',
          },
          artifact: {
            configured: false,
            loaded: false,
            selected: false,
            issue: 'disabled',
          },
          effective: {
            source: 'none',
            loaded: false,
            required: false,
            modelCount: 0,
            issue: 'disabled',
          },
        },
        benchmarkPersistence: {
          configured: false,
          available: false,
          issue: 'unconfigured',
        },
      },
    );

    expect(health.readiness?.runtime_ltr_effective).toBeDefined();
    expect(health.readiness?.runtime_ltr_effective?.required).toBe(false);
    await expect(health.readiness?.runtime_ltr_effective?.check?.()).resolves.toBe('up');
  });

  it('scopes blocker zero-candidate readiness to events after route construction', () => {
    globalSilentSkipCounter.reset();
    globalSilentSkipCounter.increment('blocker_zero_candidates');
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.blocking_zero_candidates?.check()).toBe('up');
    globalSilentSkipCounter.increment('blocker_zero_candidates');
    expect(health.readiness?.blocking_zero_candidates?.check()).toBe('down');
    globalSilentSkipCounter.reset();
  });

  it('marks watchlist runtime down when delivery is enabled but the runtime is not running', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'true',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const health = buildHealthRouteOptions(config, {}, {
      isRunning: () => false,
      start: async () => {},
      stop: async () => {},
    });

    await expect(health.readiness?.watchlist_runtime?.check?.()).resolves.toBe('down');
  });

  it('marks postgres down when the pool health query throws', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    const pool = {
      query: async () => {
        throw new Error('pg unavailable');
      },
    };

    const health = buildHealthRouteOptions(config, {
      pool: pool as never,
    });

    await expect(health.readiness?.postgres?.check?.()).resolves.toBe('down');
    expect(health.readiness?.postgres?.required).toBe(true);
  });

  it('marks redis down when the client is open but ping fails', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      KILL_SWITCH_QUERY_CACHE: 'false',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    const redisClient = {
      isOpen: true,
      ping: async () => {
        throw new Error('redis ping failed');
      },
    };

    const health = buildHealthRouteOptions(config, {
      redisClient: redisClient as never,
    });

    await expect(health.readiness?.redis?.check?.()).resolves.toBe('down');
    expect(health.readiness?.redis?.required).toBe(true);
  });
});
