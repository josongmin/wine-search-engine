/**
 * Regression: RedisWatchlistSubscriber.start() must clean up the
 * half-initialized subscriber client when connect() or pSubscribe() throws.
 *
 * Before the fix, a failed start() would:
 *   1. Assign `this.subscriber` before awaiting connect/pSubscribe
 *   2. Throw without clearing `this.subscriber`
 *   3. Leave the 'error' listener and half-open socket attached
 *   4. Make any subsequent start() either pile on another client
 *      (listener + socket accumulation) or spuriously throw
 *      "Subscriber already running" depending on timing.
 *
 * This test drives both failure sites (connect, pSubscribe) and asserts:
 *   - The client is torn down (quit or destroy was called)
 *   - The 'error' listener was removed (off was called)
 *   - A second successful start() works without "already running"
 */

import { describe, it, expect, vi } from 'vitest';
import type { RedisClientType } from 'redis';
import {
  RedisWatchlistSubscriber,
  type WatchlistEventHandler,
} from '../../src/infrastructure/watchlist/redis-watchlist-subscriber.js';

type StubClient = Pick<
  RedisClientType,
  'isOpen' | 'on' | 'off' | 'connect' | 'pSubscribe' | 'quit'
> & { destroy?: () => void };

function makeStub(opts: {
  connectFails?: boolean;
  pSubscribeFails?: boolean;
  isOpen?: boolean;
}): StubClient & {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const stub = {
    isOpen: opts.isOpen ?? true,
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => {
      if (opts.connectFails === true) {
        throw new Error('connect failed');
      }
    }),
    pSubscribe: vi.fn(async () => {
      if (opts.pSubscribeFails === true) {
        throw new Error('pSubscribe failed');
      }
    }),
    quit: vi.fn(async function quit(this: { isOpen: boolean }) {
      this.isOpen = false;
    }),
    destroy: vi.fn(),
  };
  return stub as unknown as StubClient & {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
}

const noopHandler: WatchlistEventHandler = async () => {};

describe('RedisWatchlistSubscriber leak prevention', () => {
  it('cleans up client when connect() fails', async () => {
    const failing = makeStub({ connectFails: true });
    const subscriber = new RedisWatchlistSubscriber(
      { url: 'redis://test' },
      () => failing as unknown as RedisClientType,
    );

    await expect(subscriber.start(noopHandler)).rejects.toThrow('connect failed');

    expect(failing.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(failing.off).toHaveBeenCalledWith('error', expect.any(Function));
    // isOpen was true so quit() should be called (not destroy).
    expect(failing.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.isRunning()).toBe(false);
  });

  it('cleans up client when pSubscribe() fails', async () => {
    const failing = makeStub({ pSubscribeFails: true });
    const subscriber = new RedisWatchlistSubscriber(
      { url: 'redis://test' },
      () => failing as unknown as RedisClientType,
    );

    await expect(subscriber.start(noopHandler)).rejects.toThrow('pSubscribe failed');

    expect(failing.off).toHaveBeenCalledWith('error', expect.any(Function));
    expect(failing.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.isRunning()).toBe(false);
  });

  it('destroys half-open client when connect() fails before socket is open', async () => {
    const failing = makeStub({ connectFails: true, isOpen: false });
    const subscriber = new RedisWatchlistSubscriber(
      { url: 'redis://test' },
      () => failing as unknown as RedisClientType,
    );

    await expect(subscriber.start(noopHandler)).rejects.toThrow('connect failed');

    // Socket never reached open state → use destroy() instead of quit().
    expect(failing.destroy).toHaveBeenCalledTimes(1);
    expect(failing.quit).not.toHaveBeenCalled();
  });

  it('allows a successful retry after a failed start', async () => {
    let createCount = 0;
    const clients: ReturnType<typeof makeStub>[] = [];
    const subscriber = new RedisWatchlistSubscriber(
      { url: 'redis://test' },
      () => {
        createCount += 1;
        // First create: fail. Second create: succeed.
        const stub = makeStub({ connectFails: createCount === 1 });
        clients.push(stub);
        return stub as unknown as RedisClientType;
      },
    );

    await expect(subscriber.start(noopHandler)).rejects.toThrow('connect failed');
    expect(subscriber.isRunning()).toBe(false);

    // Second attempt must not throw "Subscriber already running" —
    // the failed start must have cleared internal state.
    await subscriber.start(noopHandler);
    expect(subscriber.isRunning()).toBe(true);
    expect(clients).toHaveLength(2);

    await subscriber.stop();
    expect(subscriber.isRunning()).toBe(false);
  });
});
