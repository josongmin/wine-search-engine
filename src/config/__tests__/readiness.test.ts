import { describe, expect, it } from 'vitest';
import { buildHealthRouteOptions } from '../readiness.js';
import { parseEnv } from '../env.js';

describe('buildHealthRouteOptions', () => {
  it('marks redis as required when startup features need it, even without watchlist delivery', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'false',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.redis).toBeDefined();
    expect(health.readiness?.redis?.required).toBe(true);
    expect(health.readiness?.watchlist_runtime).toBeUndefined();
  });

  it('marks redis as required when watchlist delivery is enabled', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
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

  it('surfaces heuristic drinking-window models as a non-required degraded check', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, undefined, {
      modelVersion: 'heuristic-v1.0-enc20260405',
      predict: () => ({
        drinkingWindowStart: 2020,
        drinkingWindowEnd: 2030,
        peakYear: 2025,
        confidence: 'medium',
        modelVersion: 'heuristic-v1.0-enc20260405',
      }),
    });

    expect(health.readiness?.drinking_window_model).toBeDefined();
    expect(health.readiness?.drinking_window_model?.required).toBe(false);
    await expect(health.readiness?.drinking_window_model?.check?.()).resolves.toBe('down');
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
