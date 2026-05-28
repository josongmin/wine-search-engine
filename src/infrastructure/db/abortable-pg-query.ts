/**
 * WSE-01 — AbortSignal propagation for PostgreSQL queries.
 *
 * HTTP routes mint an {@link AbortSignal} on client disconnect / request
 * timeout, but `pg`'s pooled `query()` does not accept a signal, so an aborted
 * request still holds its backend until the server-side `statement_timeout`
 * fires (up to 30s). That leaves zombie queries piling up under load.
 *
 * This module is the single source of truth (Rule 30) for running a `pg` query
 * that actually cancels in-flight work when the caller's signal aborts.
 *
 * ## Cancellation mechanism (and why)
 *
 * node-postgres has no first-class "cancel this query" API on a pooled
 * connection. The reliable way to stop an in-flight query is to take a
 * dedicated client out of the pool with `pool.connect()`, run the query on it,
 * and on abort call `client.release(true)` — the `true` *destroys* the client
 * (closes its socket) instead of returning it to the pool. Closing the socket
 * makes the Postgres server tear down the backend that was executing the query,
 * which is exactly the cancellation we want. We deliberately do NOT use
 * `pg_cancel_backend(pid)` from a second connection: it requires tracking the
 * backend PID and opening an extra connection, a much larger blast radius for
 * the same effect.
 *
 * ## Zero-cost when no signal is supplied
 *
 * When `signal` is `undefined`, the helper falls straight through to
 * `pool.query(...)` — identical behavior and pooling to the legacy call path,
 * so existing callers that do not pass a signal are unaffected.
 */

import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { abortError, throwIfAborted } from '../../domain/shared/cooperative-abort.js';

/** Stable message for the pre-flight (already-aborted) rejection path. */
const PRE_FLIGHT_ABORT_MESSAGE = 'PostgreSQL query aborted before execution';
/** Stable message for the in-flight (aborted mid-query) rejection path. */
const IN_FLIGHT_ABORT_MESSAGE = 'PostgreSQL query aborted during execution';

/**
 * Runs a parameterized query against the pool, cancelling the underlying
 * connection if `signal` aborts.
 *
 * Behavior:
 *  - `signal` undefined → delegates to {@link Pool.query} (legacy path).
 *  - `signal` already aborted → throws an `AbortError`-named error *before*
 *    any connection is acquired (Rule 20 pre-flight check — never spend a
 *    connection on work the caller already abandoned).
 *  - `signal` aborts mid-query → the dedicated client is destroyed
 *    (`release(true)`), the server backend is torn down, and the call rejects
 *    with an `AbortError`-named error.
 *
 * The abort listener is always removed in `finally`, so a completed query
 * leaves no listener attached to a long-lived request signal (listener-leak
 * safety).
 */
export async function runAbortablePgQuery<R extends QueryResultRow>(
  pool: Pool,
  signal: AbortSignal | undefined,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  if (signal === undefined) {
    return values === undefined
      ? pool.query<R>(text)
      : pool.query<R>(text, values as unknown[]);
  }

  // Pre-flight: do not even acquire a connection if already aborted.
  throwIfAborted(signal, PRE_FLIGHT_ABORT_MESSAGE);

  const client = await pool.connect();
  // Re-check: the signal may have aborted while we were waiting for a slot.
  if (signal.aborted) {
    client.release(true);
    throw abortError(PRE_FLIGHT_ABORT_MESSAGE);
  }

  // `destroyed` records whether the abort listener already released (destroyed)
  // the client. It is mutated only inside the closure below, so the
  // catch/finally must read it as a genuine runtime value — the
  // `no-unnecessary-condition` disables flag that the static analyzer cannot
  // see the closure write.
  let destroyed = false;
  const onAbort = (): void => {
    destroyed = true;
    // Destroy the client (true) so the socket closes and the server backend
    // running this query is torn down rather than the connection being reused.
    client.release(true);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result =
      values === undefined
        ? await client.query<R>(text)
        : await client.query<R>(text, values as unknown[]);
    return result;
  } catch (err) {
    // If the rejection is the consequence of our own destroy(), surface a
    // canonical AbortError instead of the opaque socket error pg emits.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `destroyed` is mutated inside the abort listener closure
    if (destroyed) {
      throw abortError(IN_FLIGHT_ABORT_MESSAGE, err);
    }
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Only release here when the abort listener did NOT already destroy the
    // client. Releasing twice is a bug.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `destroyed` is mutated inside the abort listener closure
    if (!destroyed) {
      client.release();
    }
  }
}
