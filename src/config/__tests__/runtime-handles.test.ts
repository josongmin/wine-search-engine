import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { createManagedRuntimeHandles } from '../runtime-handles.js';

const {
  closePgPoolMock,
  closeRedisClientMock,
} = vi.hoisted(() => ({
  closePgPoolMock: vi.fn(),
  closeRedisClientMock: vi.fn(),
}));

vi.mock('../../infrastructure/db/pg-pool.js', () => ({
  closePgPool: closePgPoolMock,
}));

vi.mock('../../infrastructure/db/redis-client.js', () => ({
  closeRedisClient: closeRedisClientMock,
}));

describe('createManagedRuntimeHandles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes runtime dependencies only once even when close is called repeatedly', async () => {
    const telemetryShutdown = vi.fn<() => Promise<void>>().mockResolvedValue();
    const runtime = createManagedRuntimeHandles(
      {
        pool: {} as never,
        redisClient: {} as never,
      },
      {
        telemetrySdk: { shutdown: telemetryShutdown } as NodeSDK,
      },
    );

    await runtime.close();
    await runtime.close();

    expect(closePgPoolMock).toHaveBeenCalledTimes(1);
    expect(closeRedisClientMock).toHaveBeenCalledTimes(1);
    expect(telemetryShutdown).toHaveBeenCalledTimes(1);
  });

  it('surfaces aggregated shutdown failures', async () => {
    const pgError = new Error('pg close failed');
    const redisError = new Error('redis close failed');
    closePgPoolMock.mockRejectedValueOnce(pgError);
    closeRedisClientMock.mockRejectedValueOnce(redisError);

    const runtime = createManagedRuntimeHandles({});

    await expect(runtime.close()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([pgError, redisError]),
    });
  });
});
