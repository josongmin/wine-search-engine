import { createContainer, type Container } from '../../../config/container.js';
import { loadConfig } from '../../../config/env.js';
import {
  bindLiveSearchSnapshotRuntimeHandles,
  createManagedRuntimeHandles,
  type RuntimeHandles,
} from '../../../config/runtime-handles.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { connectRedisClient } from '../../db/redis-client.js';
import { createPgPool, shouldUsePgPool } from '../../db/pg-pool.js';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
const CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV = 'WINE_CLI_SUPPRESS_OBSERVABILITY_LOGS';

export class LocalContainerRuntime {
  constructor(private readonly env: EnvLike = process.env) {}

  async withContainer<T>(work: (container: Container) => Promise<T>): Promise<T> {
    // We mutate `bootstrapLogger.level` and a process env flag for the duration
    // of a single CLI invocation so structured pipeline logs do not pollute
    // stdout. Both are restored in `finally`. Safe because the CLI process is
    // short-lived and single-tenant; do NOT call from a long-lived server
    // process where another component shares the same logger.
    const previousLevel = bootstrapLogger.level;
    const previousObservabilityGate = process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV];
    bootstrapLogger.level = 'silent';
    process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV] = 'true';
    const config = loadConfig({ env: this.env });
    const pool = shouldUsePgPool(config.pg) ? createPgPool(config.pg) : undefined;
    const redisClient = config.redis.url !== undefined
      ? await connectRedisClient(config.redis)
      : undefined;
    const runtime = await bindLiveSearchSnapshotRuntimeHandles({
      ...(pool !== undefined ? { pool } : {}),
      ...(redisClient !== undefined ? { redisClient } : {}),
    } satisfies RuntimeHandles);
    const managedRuntime = createManagedRuntimeHandles(runtime);
    try {
      const container = await createContainer(config, managedRuntime);
      return await work(container);
    } finally {
      await managedRuntime.close();
      bootstrapLogger.level = previousLevel;
      if (previousObservabilityGate === undefined) {
        delete process.env.WINE_CLI_SUPPRESS_OBSERVABILITY_LOGS;
      } else {
        process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV] = previousObservabilityGate;
      }
    }
  }
}
