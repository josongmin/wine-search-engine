import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';

describe('alias substrate readiness', () => {
  function makePool(rows: readonly unknown[]): {
    connect: () => Promise<{
      query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
      release: () => void;
    }>;
  } {
    let i = 0;
    return {
      connect: async () => ({
        query: async (sql: string, _values?: readonly unknown[]) => {
          if (
            sql === 'BEGIN'
            || sql === 'ROLLBACK'
            || sql === 'COMMIT'
            || sql.startsWith('SET LOCAL statement_timeout')
          ) {
            return { rows: [], rowCount: 0 };
          }
          const next = rows[i++];
          if (next instanceof Error) {
            throw next;
          }
          return (next as { rows: unknown[]; rowCount?: number }) ?? { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    };
  }

  it('registers alias_substrate as a non-critical probe when a PG runtime is present', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_QUERY_CACHE: 'true',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {
      pool: makePool([]) as never,
    });

    expect(health.readiness?.alias_substrate).toBeDefined();
    expect(health.readiness?.alias_substrate?.required).toBe(false);
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
    const pool = makePool([{ rows: [] }]);

    const health = buildHealthRouteOptions(config, {
      pool: pool as never,
    });

    await expect(health.readiness?.alias_substrate?.check?.()).resolves.toBe('down');
  });
});
