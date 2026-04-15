/**
 * Wave 3 — Transaction/event fail-loud regressions.
 *
 * Covers:
 *  - C6 / pg-watchlist-store: rollback failure → TransactionRollbackFailedError
 *    (carries both original + rollback error, never silent swallow)
 *  - H12 / redis-watchlist-subscriber: handler retry + DLQ when exhausted
 *  - H13 / health route: structured probe outcome with reason + errorClass
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryWatchlistPoisonStore,
  RedisWatchlistSubscriber,
  type WatchlistPoisonRecord,
} from '../../src/infrastructure/watchlist/redis-watchlist-subscriber.js';
import { TransactionRollbackFailedError } from '../../src/infrastructure/watchlist/pg-watchlist-store.js';

describe('Wave 3 / C6: TransactionRollbackFailedError', () => {
  it('preserves both original and rollback errors in the message', () => {
    const original = new Error('insert failed');
    const rollback = new Error('connection dropped');
    const e = new TransactionRollbackFailedError(original, rollback);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TransactionRollbackFailedError');
    expect(e.originalError).toBe(original);
    expect(e.rollbackError).toBe(rollback);
    expect(e.message).toContain('insert failed');
    expect(e.message).toContain('connection dropped');
    expect(e.message).toMatch(/Transaction state is unknown/);
  });

  it('handles non-Error original/rollback gracefully', () => {
    const e = new TransactionRollbackFailedError('string-original', { code: 42 });
    expect(e.message).toContain('string-original');
    // Non-Error objects stringify to [object Object]; the structured properties
    // (.originalError, .rollbackError) carry the real values.
    expect(e.message).toContain('[object Object]');
    expect(e.rollbackError).toEqual({ code: 42 });
  });
});

describe('Wave 3 / C6: pg-watchlist-store rollback path source check', () => {
  it('replaces silent .catch(() => {}) with TransactionRollbackFailedError', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/watchlist/pg-watchlist-store.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).not.toMatch(/ROLLBACK['"]\)\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/TransactionRollbackFailedError/);
    expect(src).toMatch(/throw new TransactionRollbackFailedError/);
  });
});

describe('Wave 3 / H12: Watchlist subscriber DLQ + retry', () => {
  it('InMemoryWatchlistPoisonStore push/size round-trip', async () => {
    const store = new InMemoryWatchlistPoisonStore();
    expect(await store.size()).toBe(0);
    const rec: WatchlistPoisonRecord = {
      entityId: 'e1',
      rawPayload: '{"x":1}',
      attempts: 4,
      lastError: 'boom',
      firstSeenAt: new Date(),
      poisonedAt: new Date(),
    };
    await store.push(rec);
    expect(await store.size()).toBe(1);
    expect(store.snapshot()).toEqual([rec]);
  });

  it('RedisWatchlistSubscriber handleEvent retries then poisons on persistent failure', async () => {
    const store = new InMemoryWatchlistPoisonStore();
    const sub = new RedisWatchlistSubscriber(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub for redis config
      {} as never,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- factory unused in this test
      (() => ({})) as never,
      { poisonStore: store, retryDelaysMs: [0, 0, 0] }, // 4 attempts total, no real wait
    );
    const handler = vi.fn().mockRejectedValue(new Error('persistent failure'));
    // Reach into the private method via a typed helper for the test only.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- access private for test
    const handleEvent = (sub as unknown as {
      handleEvent: (id: string, payload: string, h: typeof handler) => Promise<void>;
    }).handleEvent.bind(sub);

    await handleEvent('e1', '{"type":"vintage_released","occurredAt":"2026-04-14T00:00:00.000Z","data":{"vintage":2018,"canonicalLabel":"Opus One"}}', handler);

    expect(handler).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(await sub.poisonStoreSize()).toBe(1);
    const recorded = store.snapshot()[0];
    expect(recorded?.entityId).toBe('e1');
    expect(recorded?.attempts).toBe(4);
    expect(recorded?.lastError).toContain('persistent failure');
  });

  it('handleEvent succeeds on second attempt — no DLQ entry', async () => {
    const store = new InMemoryWatchlistPoisonStore();
    const sub = new RedisWatchlistSubscriber(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
      {} as never,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- factory unused
      (() => ({})) as never,
      { poisonStore: store, retryDelaysMs: [0] },
    );
    let calls = 0;
    const handler = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- private access for test
    const handleEvent = (sub as unknown as {
      handleEvent: (id: string, payload: string, h: typeof handler) => Promise<void>;
    }).handleEvent.bind(sub);

    await handleEvent('e2', '{"type":"vintage_released","occurredAt":"2026-04-14T00:00:00.000Z","data":{"vintage":2019,"canonicalLabel":"Sassicaia"}}', handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await sub.poisonStoreSize()).toBe(0);
  });

  it('invalid payload poisons immediately after retry exhaustion (parse never recovers)', async () => {
    const store = new InMemoryWatchlistPoisonStore();
    const sub = new RedisWatchlistSubscriber(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
      {} as never,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- factory unused
      (() => ({})) as never,
      { poisonStore: store, retryDelaysMs: [0, 0] }, // 3 total attempts
    );
    const handler = vi.fn();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- private access for test
    const handleEvent = (sub as unknown as {
      handleEvent: (id: string, payload: string, h: typeof handler) => Promise<void>;
    }).handleEvent.bind(sub);

    await handleEvent('e3', '{not json', handler);
    // handler never invoked — payload fails the JSON.parse pre-check.
    expect(handler).not.toHaveBeenCalled();
    expect(await sub.poisonStoreSize()).toBe(1);
    const rec = store.snapshot()[0];
    expect(rec?.attempts).toBe(3);
  });
});

describe('Wave 3 / H13: health probe structured outcome wiring', () => {
  it('health.route exposes resolveProbeOutcome with reason+errorClass', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/interface/http/routes/health.route.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/interface ProbeOutcome/);
    expect(src).toMatch(/async function resolveProbeOutcome\(/);
    expect(src).toMatch(/errorClass = err instanceof Error/);
    expect(src).toMatch(/readiness probe/);
  });
});
