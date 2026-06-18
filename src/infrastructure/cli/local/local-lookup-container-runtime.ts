import { loadConfig } from '../../../config/env.js';
import { createLookupDirectContainer, type LookupDirectContainer } from '../../../config/container-lookup.js';
import {
  bindLiveSearchSnapshotRuntimeHandles,
  createManagedRuntimeHandles,
  type RuntimeHandles,
} from '../../../config/runtime-handles.js';
import { loadSearchSnapshotRuntimeState } from '../../../infrastructure/health/search-snapshot-readiness.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { connectRedisClient } from '../../db/redis-client.js';
import { createPgPool, shouldUsePgPool } from '../../db/pg-pool.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
const CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV = 'WINE_CLI_SUPPRESS_OBSERVABILITY_LOGS';

interface CachedLookupRuntimeState {
  readonly snapshotId: string;
  readonly managedRuntime: RuntimeHandles & { close(): Promise<void> };
  readonly container: LookupDirectContainer;
}

export class LocalLookupContainerRuntime {
  private cachedStatePromise: Promise<CachedLookupRuntimeState> | null = null;
  private cachedSnapshotId: string | null = null;

  constructor(private readonly env: EnvLike = process.env) {}

  private async withSuppressedObservability<T>(work: () => Promise<T>): Promise<T> {
    const previousLevel = bootstrapLogger.level;
    const previousObservabilityGate = process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV];
    bootstrapLogger.level = 'silent';
    process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV] = 'true';
    try {
      return await work();
    } finally {
      bootstrapLogger.level = previousLevel;
      if (previousObservabilityGate === undefined) {
        delete process.env.WINE_CLI_SUPPRESS_OBSERVABILITY_LOGS;
      } else {
        process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV] = previousObservabilityGate;
      }
    }
  }

  private async buildCachedState(snapshotState: Awaited<ReturnType<typeof loadSearchSnapshotRuntimeState>>): Promise<CachedLookupRuntimeState> {
    const config = loadConfig({ env: this.env });
    const pool = shouldUsePgPool(config.pg) ? createPgPool(config.pg) : undefined;
    const redisClient = config.redis.url !== undefined
      ? await connectRedisClient(config.redis)
      : undefined;
    const runtime = await bindLiveSearchSnapshotRuntimeHandles({
      ...(pool !== undefined ? { pool } : {}),
      ...(redisClient !== undefined ? { redisClient } : {}),
      searchSnapshotId: snapshotState.snapshotId,
      searchSnapshotManifestPath: snapshotState.manifestPath,
      searchSnapshotFieldAvailability: snapshotState.fieldAvailability,
    } satisfies RuntimeHandles);
    const managedRuntime = createManagedRuntimeHandles(runtime);
    try {
      const container = await createLookupDirectContainer(config, managedRuntime);
      return {
        snapshotId: snapshotState.snapshotId,
        managedRuntime,
        container,
      };
    } catch (error) {
      await managedRuntime.close();
      throw error;
    }
  }

  private async ensureCachedState(): Promise<CachedLookupRuntimeState> {
    const snapshotState = await loadSearchSnapshotRuntimeState();
    if (this.cachedStatePromise !== null && this.cachedSnapshotId === snapshotState.snapshotId) {
      return await this.cachedStatePromise;
    }

    const previousSnapshotId = this.cachedSnapshotId;
    const previousStatePromise = this.cachedStatePromise;
    const nextStatePromise = this.buildCachedState(snapshotState);
    this.cachedSnapshotId = snapshotState.snapshotId;
    this.cachedStatePromise = nextStatePromise;

    try {
      const nextState = await nextStatePromise;
      if (
        previousStatePromise !== null
        && previousSnapshotId !== null
        && previousSnapshotId !== snapshotState.snapshotId
      ) {
        const previousState = await previousStatePromise;
        await previousState.managedRuntime.close();
      }
      return nextState;
    } catch (error) {
      if (this.cachedStatePromise === nextStatePromise) {
        this.cachedStatePromise = previousStatePromise;
        this.cachedSnapshotId = previousSnapshotId;
      }
      throw error;
    }
  }

  async preload(): Promise<void> {
    await this.withSuppressedObservability(async () => {
      await this.ensureCachedState();
    });
  }

  async close(): Promise<void> {
    const cachedStatePromise = this.cachedStatePromise;
    this.cachedStatePromise = null;
    this.cachedSnapshotId = null;
    if (cachedStatePromise === null) {
      return;
    }
    const cachedState = await cachedStatePromise;
    await cachedState.managedRuntime.close();
  }

  async withContainer<T>(work: (container: LookupDirectContainer) => Promise<T>): Promise<T> {
    return await this.withSuppressedObservability(async () => {
      const cachedState = await this.ensureCachedState();
      return await work(cachedState.container);
    });
  }
}
