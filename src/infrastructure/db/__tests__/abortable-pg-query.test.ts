import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { runAbortablePgQuery } from '../abortable-pg-query.js';
import { isAbortError } from '../../../domain/shared/cooperative-abort.js';

/**
 * Unit contract for the abort-aware pg query helper. No real DB — the pool and
 * pooled client are stubbed inline so we can assert the cancellation wiring:
 *  - no signal → straight pool.query, no connection checked out
 *  - already-aborted signal → rejects before any connection is acquired
 *  - aborts mid-query → dedicated client destroyed (release(true)), rejects AbortError
 *  - normal completion → client returned to pool intact, listener removed
 */

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  resolver: () => Promise<{ rows: unknown[] }>,
): FakeClient {
  return {
    query: vi.fn(resolver),
    release: vi.fn(),
  };
}

interface FakePoolParts {
  pool: Pool;
  poolQuery: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  client: FakeClient;
}

function makeFakePool(clientResolver: () => Promise<{ rows: unknown[] }>): FakePoolParts {
  const client = makeFakeClient(clientResolver);
  const poolQuery = vi.fn(() => Promise.resolve({ rows: [{ via: 'pool' }] }));
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = {
    query: poolQuery,
    connect,
  } as unknown as Pool;
  return { pool, poolQuery, connect, client };
}

describe('runAbortablePgQuery', () => {
  it('delegates to pool.query and never checks out a client when no signal is given', async () => {
    const { pool, poolQuery, connect } = makeFakePool(() =>
      Promise.resolve({ rows: [{ via: 'client' }] }),
    );

    const result = await runAbortablePgQuery(pool, undefined, 'SELECT 1', [1]);

    expect(result.rows).toEqual([{ via: 'pool' }]);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('throws AbortError before acquiring a connection when the signal is already aborted', async () => {
    const { pool, poolQuery, connect } = makeFakePool(() =>
      Promise.resolve({ rows: [] }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAbortablePgQuery(pool, controller.signal, 'SELECT 1'),
    ).rejects.toSatisfy(isAbortError);

    // Pre-flight: neither the pool nor a dedicated client was used.
    expect(connect).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('routes through a dedicated client when a (live) signal is given and releases it on success', async () => {
    const { pool, poolQuery, connect, client } = makeFakePool(() =>
      Promise.resolve({ rows: [{ via: 'client' }] }),
    );
    const controller = new AbortController();

    const result = await runAbortablePgQuery(pool, controller.signal, 'SELECT 1', [42]);

    expect(result.rows).toEqual([{ via: 'client' }]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    // Released intact (no destroy flag) on the happy path.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
    // Listener cleanup: aborting after completion must NOT destroy anything.
    controller.abort();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('destroys the client and rejects with AbortError when the signal aborts mid-query', async () => {
    const controller = new AbortController();
    let rejectQuery: (err: Error) => void = () => {
      /* assigned below */
    };
    // The client query hangs until the abort destroys the connection, then the
    // driver rejects with a socket error — emulated here.
    const clientResolver = (): Promise<{ rows: unknown[] }> =>
      new Promise((_resolve, reject) => {
        rejectQuery = reject;
      });
    const { pool, client } = makeFakePool(clientResolver);

    // release(true) is what a real abort triggers; simulate the driver
    // rejecting the in-flight query once the socket is destroyed.
    client.release.mockImplementation((destroy?: boolean) => {
      if (destroy === true) {
        rejectQuery(new Error('Connection terminated unexpectedly'));
      }
    });

    const promise = runAbortablePgQuery(pool, controller.signal, 'SELECT pg_sleep(60)');
    // Let the helper attach its abort listener before firing.
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toSatisfy(isAbortError);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('propagates a genuine query error unchanged (not masked as AbortError)', async () => {
    const dbError = new Error('relation "missing" does not exist');
    const { pool } = makeFakePool(() => Promise.reject(dbError));
    const controller = new AbortController();

    await expect(
      runAbortablePgQuery(pool, controller.signal, 'SELECT * FROM missing'),
    ).rejects.toBe(dbError);
  });
});
