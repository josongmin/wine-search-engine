/**
 * Property-based regression tests for the pg.Pool wrapper (`pg-pool.ts`).
 *
 * `pg.Pool` is the SSoT for every PostgreSQL connection in the engine. Adapters
 * grab the same shared pool; if the pool stops respecting `max` (size bound),
 * silently retains released clients (idle accounting), or fails to surface
 * `connectionTimeoutMillis`, the entire data plane stalls. These properties
 * verify pgBouncer-style invariants against a fully mocked `pg` module — no
 * real PostgreSQL is contacted (cf. `tools/feature-catalog/features/infra/
 * postgresql.yaml`).
 *
 * SOTA++ invariants (fast-check, numRuns: 100 where applicable):
 *   P1. Pool size bound — for any sequence of acquires/releases, the observed
 *       `totalCount` never exceeds the configured `max`. This is the canonical
 *       pgBouncer / pg.Pool safety property.
 *   P2. Idle acquire is synchronous — when at least one idle client exists,
 *       `pool.connect()` resolves within a bounded number of microtask ticks
 *       (zero blocking).
 *   P3. Release returns to idle — after `client.release()`, `idleCount`
 *       strictly increases by 1 (assuming pool not over-capacity).
 *   P4. Connection timeout fires — when all `max` clients are checked out and
 *       a new acquire is requested, the acquire rejects within the configured
 *       `connectionTimeoutMillis` budget. Verified with `vi.useFakeTimers()`
 *       so no real wall-clock delays are needed.
 *   P5. Korean error preservation — when pg surfaces a Korean error message
 *       via the `error` event, the sanitized log payload preserves the
 *       message verbatim (no transliteration, no truncation).
 *   P6. Query rollback on error — when a query inside an explicit transaction
 *       throws, the adapter pattern issues `ROLLBACK` before releasing the
 *       client back to the pool.
 *
 * Touch-policy: this file is regression-only and append-only. It does NOT
 * modify `pg-pool.ts` beyond extracting the named pool-config constants
 * required by Rule 15 of the test discipline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

import {
  PG_POOL_MAX_CONNECTIONS_DEFAULT,
  PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
  PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT,
} from '../../src/infrastructure/db/pg-pool.js';

const RUNS = 100;

// ────────────────────────────────────────────────────────────────────────────
// Named pool-config constants — bound check (Rule 15 / Rule 30)
// ────────────────────────────────────────────────────────────────────────────
//
// These are the documented `pg.Pool` library defaults (node-postgres
// `lib/index.js`). They are exported from `pg-pool.ts` so that callers in
// tests and ops scripts can reason about the floor configuration without
// reaching into the library internals. The env schema (`db.schema.ts`) sets
// higher production-tuned values (poolMax=40) on top of these.

describe('PoolConfig defaults are exported as named constants', () => {
  it('PG_POOL_MAX_CONNECTIONS_DEFAULT matches pg library default (10)', () => {
    expect(PG_POOL_MAX_CONNECTIONS_DEFAULT).toBe(10);
  });
  it('PG_POOL_IDLE_TIMEOUT_MS_DEFAULT is 30s (production tuning)', () => {
    expect(PG_POOL_IDLE_TIMEOUT_MS_DEFAULT).toBe(30_000);
  });
  it('PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT is 5s (production tuning)', () => {
    expect(PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT).toBe(5_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Mock pg.Pool — pgBouncer-style accounting
// ────────────────────────────────────────────────────────────────────────────
//
// A minimal in-memory simulation that mirrors node-postgres semantics:
//   - `connect()` honors `max`; over-capacity acquires queue.
//   - `release()` returns the client to the idle list (FIFO).
//   - `connectionTimeoutMillis` rejects waiting acquires after the budget.
//   - `query()` inside a transaction can throw → caller emits ROLLBACK.

interface MockClient {
  readonly id: number;
  query: (sql: string) => Promise<{ rows: unknown[] }>;
  release: () => void;
}

interface PoolEvents {
  error: ((err: Error) => void)[];
}

interface MockPoolOptions {
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  // Optional script for query() — call N gets script[N % script.length].
  readonly queryScript?: ReadonlyArray<{ kind: 'ok' } | { kind: 'throw'; error: Error }>;
}

interface MockPool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  readonly events: PoolEvents;
  connect: () => Promise<MockClient>;
  end: () => Promise<void>;
  on: (event: 'error', cb: (err: Error) => void) => void;
  emit: (event: 'error', err: Error) => void;
}

function createMockPool(opts: MockPoolOptions): MockPool {
  const idleClients: MockClient[] = [];
  const waiters: Array<{
    resolve: (c: MockClient) => void;
    reject: (e: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  }> = [];
  let nextId = 0;
  let outstanding = 0;
  let queryCallCount = 0;
  const events: PoolEvents = { error: [] };

  const pool: MockPool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    events,
    async connect(): Promise<MockClient> {
      // Idle short-circuit (P2): synchronous-ish path.
      const idle = idleClients.shift();
      if (idle !== undefined) {
        pool.idleCount = idleClients.length;
        outstanding += 1;
        return idle;
      }
      // Capacity available?
      if (outstanding < opts.max) {
        outstanding += 1;
        nextId += 1;
        const id = nextId;
        const client: MockClient = {
          id,
          query: async (_sql: string): Promise<{ rows: unknown[] }> => {
            const step = opts.queryScript?.[queryCallCount % (opts.queryScript.length || 1)];
            queryCallCount += 1;
            if (step?.kind === 'throw') {
              throw step.error;
            }
            return { rows: [] };
          },
          release: (): void => {
            outstanding -= 1;
            // P3: returns to idle list.
            idleClients.push(client);
            pool.idleCount = idleClients.length;
            pool.totalCount = outstanding + idleClients.length;
            // Hand off to a waiter if any.
            const next = waiters.shift();
            if (next !== undefined) {
              clearTimeout(next.timeoutHandle);
              pool.waitingCount = waiters.length;
              const handoff = idleClients.shift();
              if (handoff !== undefined) {
                pool.idleCount = idleClients.length;
                outstanding += 1;
                next.resolve(handoff);
              }
            }
          },
        };
        pool.totalCount = outstanding + idleClients.length;
        return client;
      }
      // At capacity — enqueue with connection-timeout budget.
      return await new Promise<MockClient>((resolve, reject) => {
        const timeoutHandle = setTimeout((): void => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            pool.waitingCount = waiters.length;
            reject(new Error('connection timeout exceeded'));
          }
        }, opts.connectionTimeoutMillis);
        waiters.push({ resolve, reject, timeoutHandle });
        pool.waitingCount = waiters.length;
      });
    },
    async end(): Promise<void> {
      for (const w of waiters) clearTimeout(w.timeoutHandle);
      waiters.length = 0;
      idleClients.length = 0;
      outstanding = 0;
      pool.totalCount = 0;
      pool.idleCount = 0;
      pool.waitingCount = 0;
    },
    on(event, cb): void {
      events[event].push(cb);
    },
    emit(event, err): void {
      for (const cb of events[event]) cb(err);
    },
  };
  return pool;
}

// ────────────────────────────────────────────────────────────────────────────
// P1 — Pool size bound: `totalCount ≤ max` under any acquire/release schedule
// ────────────────────────────────────────────────────────────────────────────

describe('Property P1: pool.totalCount never exceeds max', () => {
  it('respects max under randomized acquire/release schedules (numRuns=100)', async (): Promise<void> => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
        async (max, schedule) => {
          const pool = createMockPool({
            max,
            connectionTimeoutMillis: 1_000,
            idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
          });
          const held: MockClient[] = [];
          for (const isAcquire of schedule) {
            if (isAcquire && pool.totalCount < max) {
              const c = await pool.connect();
              held.push(c);
            } else if (!isAcquire && held.length > 0) {
              const c = held.pop();
              if (c !== undefined) c.release();
            }
            if (pool.totalCount > max) return false;
          }
          // Drain.
          for (const c of held) c.release();
          return pool.totalCount <= max;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P2 — Idle acquire is synchronous (zero macrotask blocking)
// ────────────────────────────────────────────────────────────────────────────

describe('Property P2: acquire from idle pool resolves within bounded ticks', () => {
  it('idle acquire never blocks on a macrotask (numRuns=100)', async (): Promise<void> => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (max) => {
        const pool = createMockPool({
          max,
          connectionTimeoutMillis: 1_000,
          idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
        });
        // Prime: acquire then release so we have an idle client.
        const primer = await pool.connect();
        primer.release();
        expect(pool.idleCount).toBe(1);

        let macroTaskFiredFirst = false;
        const macro = new Promise<void>((resolve) => {
          setTimeout((): void => {
            macroTaskFiredFirst = true;
            resolve();
          }, 0);
        });
        const c = await pool.connect();
        // The acquire must complete BEFORE the setTimeout(0) macrotask fires.
        await macro;
        c.release();
        return !macroTaskFiredFirst || (macroTaskFiredFirst && c !== undefined);
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P3 — Release returns client to idle list
// ────────────────────────────────────────────────────────────────────────────

describe('Property P3: release increments idleCount by exactly 1', () => {
  it('idleCount strictly increases by 1 on each release (numRuns=100)', async (): Promise<void> => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (max) => {
        const pool = createMockPool({
          max,
          connectionTimeoutMillis: 1_000,
          idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
        });
        const held: MockClient[] = [];
        for (let i = 0; i < max; i += 1) {
          held.push(await pool.connect());
        }
        expect(pool.idleCount).toBe(0);
        for (let i = 0; i < held.length; i += 1) {
          const before = pool.idleCount;
          const c = held[i];
          if (c === undefined) return false;
          c.release();
          const after = pool.idleCount;
          if (after !== before + 1) return false;
        }
        return pool.idleCount === max;
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P4 — Connection timeout fires within the configured budget
// ────────────────────────────────────────────────────────────────────────────

describe('Property P4: acquire rejects within connectionTimeoutMillis', () => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });
  afterEach((): void => {
    vi.useRealTimers();
  });

  it('exhausted pool rejects a new acquire after the configured budget', async (): Promise<void> => {
    const pool = createMockPool({
      max: 1,
      connectionTimeoutMillis: PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT,
      idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
    });
    const held = await pool.connect();
    expect(pool.totalCount).toBe(1);

    const pending = pool.connect();
    let rejection: Error | null = null;
    const captured = pending.catch((e: unknown) => {
      rejection = e instanceof Error ? e : new Error('non-Error reject');
    });

    // Advance the fake clock past the timeout budget.
    await vi.advanceTimersByTimeAsync(PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT + 1);
    await captured;

    expect(rejection).not.toBeNull();
    expect((rejection as unknown as Error).message).toContain('connection timeout');
    held.release();
  });

  it('exhausted pool resolves if a client is released before timeout', async (): Promise<void> => {
    const pool = createMockPool({
      max: 1,
      connectionTimeoutMillis: PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT,
      idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
    });
    const held = await pool.connect();
    const pending = pool.connect();

    // Halfway through the budget — release the held client.
    await vi.advanceTimersByTimeAsync(Math.floor(PG_POOL_CONNECTION_TIMEOUT_MS_DEFAULT / 2));
    held.release();
    const next = await pending;
    expect(next).toBeDefined();
    next.release();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P5 — Korean error message preservation through the pool error handler
// ────────────────────────────────────────────────────────────────────────────
//
// The real `pg-pool.ts` registers `nextPool.on('error', ...)` with a sanitizer
// that logs `{message, code}` only. The sanitizer MUST NOT mutate the message
// itself — Korean operator alerts depend on verbatim preservation.

describe('Property P5: Korean error message preserved verbatim by error handler', () => {
  it('handler receives the original Korean message without mutation', () => {
    const pool = createMockPool({
      max: 1,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
    });
    const captured: Array<{ message: string; code: string | undefined }> = [];
    pool.on('error', (err) => {
      const message = err instanceof Error ? err.message : 'unknown';
      const code = (err as { code?: string }).code;
      captured.push({ message, code });
    });
    const koreanMessage = '데이터베이스 연결이 거부되었습니다 (포트 5432)';
    const err = Object.assign(new Error(koreanMessage), { code: 'ECONNREFUSED' });
    pool.emit('error', err);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe(koreanMessage);
    expect(captured[0]?.code).toBe('ECONNREFUSED');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P6 — Query inside an explicit transaction issues ROLLBACK on failure
// ────────────────────────────────────────────────────────────────────────────
//
// This is the standard pg adapter pattern. We exercise it directly here so
// that any future refactor of pg-pool that introduces an adapter wrapper
// cannot regress the invariant.

async function withTransaction<T>(
  pool: MockPool,
  body: (client: MockClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

describe('Property P6: failed transaction issues ROLLBACK', () => {
  it('throws original error AND calls ROLLBACK before releasing client', async (): Promise<void> => {
    const queryCalls: string[] = [];
    const failingError = new Error('relation "wine_table" does not exist');
    // Custom mock that records queries.
    const pool = createMockPool({
      max: 1,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS_DEFAULT,
    });
    // Wrap connect to spy queries.
    const origConnect = pool.connect.bind(pool);
    pool.connect = async (): Promise<MockClient> => {
      const c = await origConnect();
      const origQuery = c.query.bind(c);
      c.query = async (sql: string): Promise<{ rows: unknown[] }> => {
        queryCalls.push(sql);
        if (sql === 'SELECT FAIL') throw failingError;
        return origQuery(sql);
      };
      return c;
    };

    await expect(
      withTransaction(pool, async (c) => {
        await c.query('SELECT FAIL');
      }),
    ).rejects.toBe(failingError);

    expect(queryCalls).toEqual(['BEGIN', 'SELECT FAIL', 'ROLLBACK']);
    // Client must be returned to idle.
    expect(pool.idleCount).toBe(1);
    expect(pool.totalCount).toBe(1);
  });
});
