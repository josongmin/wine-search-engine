import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import {
  bindLiveSearchSnapshotRuntimeHandles,
  createManagedRuntimeHandles,
} from '../runtime-handles.js';

const {
  closePgPoolMock,
  closeRedisClientMock,
  loadSearchSnapshotRuntimeStateMock,
} = vi.hoisted(() => ({
  closePgPoolMock: vi.fn(),
  closeRedisClientMock: vi.fn(),
  loadSearchSnapshotRuntimeStateMock: vi.fn(),
}));

vi.mock('../../infrastructure/db/pg-pool.js', () => ({
  closePgPool: closePgPoolMock,
}));

vi.mock('../../infrastructure/db/redis-client.js', () => ({
  closeRedisClient: closeRedisClientMock,
}));

vi.mock('../../infrastructure/health/search-snapshot-readiness.js', () => ({
  loadSearchSnapshotRuntimeState: loadSearchSnapshotRuntimeStateMock,
}));

describe('createManagedRuntimeHandles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSearchSnapshotRuntimeStateMock.mockResolvedValue({
      snapshotId: 'search-snapshot:v1:active',
      manifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
      fieldAvailability: { appellation: { populatedCount: 1, totalCount: 1, populatedRatio: 1 } },
    });
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

  it('binds pool-backed live runtimes to the published snapshot state', async () => {
    const bound = await bindLiveSearchSnapshotRuntimeHandles({
      pool: {} as never,
    });

    expect(loadSearchSnapshotRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(bound).toMatchObject({
      pool: expect.anything(),
      searchSnapshotId: 'search-snapshot:v1:active',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
    });
  });

  it('preserves explicit snapshot bindings without reloading runtime state', async () => {
    const runtime = {
      pool: {} as never,
      searchSnapshotId: 'search-snapshot:v1:shadow',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:shadow/manifest.json',
    };

    const bound = await bindLiveSearchSnapshotRuntimeHandles(runtime);

    expect(loadSearchSnapshotRuntimeStateMock).not.toHaveBeenCalled();
    expect(bound).toBe(runtime);
  });
});
