import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';

describe('alias substrate readiness', () => {
  it('registers alias_substrate as a required probe when a PG runtime is present', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {
      pool: { query: async () => ({ rows: [] }) } as never,
    });

    expect(health.readiness?.alias_substrate).toBeDefined();
    expect(health.readiness?.alias_substrate?.required).toBe(true);
  });

  it('fails closed for alias and snapshot substrate readiness in production without a PG runtime', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.alias_substrate).toBeDefined();
    await expect(health.readiness?.alias_substrate?.check?.()).resolves.toBe('down');
    await expect(health.readiness?.search_snapshot_runtime?.check?.()).resolves.toBe('down');
  });

  it('marks alias_substrate down when the active snapshot pointer is missing', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    const pool = {
      query: async () => ({ rows: [] }),
    };

    const health = buildHealthRouteOptions(config, {
      pool: pool as never,
    });

    await expect(health.readiness?.alias_substrate?.check?.()).resolves.toBe('down');
  });
});
