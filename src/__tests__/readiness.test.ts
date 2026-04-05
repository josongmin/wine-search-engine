import { describe, expect, it } from 'vitest';
import { buildHealthRouteOptions } from '../config/readiness.js';
import { parseEnv } from '../config/env.js';

describe('watchlist env config', () => {
  it('enables watchlist explicitly when WATCHLIST_ENABLED is true', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'true',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(config.watchlist.enabled).toBe(true);
  });

  it('allows explicitly disabling watchlist even when a secret is present', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WATCHLIST_ENABLED: 'false',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(config.watchlist.enabled).toBe(false);
  });

  it('rejects enabling watchlist without a webhook secret', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'test',
        WATCHLIST_ENABLED: 'true',
      })
    ).toThrow('WATCHLIST_ENABLED requires WEBHOOK_SECRET to be set');
  });
});

describe('buildHealthRouteOptions', () => {
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
});
