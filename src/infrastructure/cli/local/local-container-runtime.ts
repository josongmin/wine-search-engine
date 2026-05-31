import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
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
const AGENT_SESSION_DB_PATH_ENV = 'AGENT_SESSION_DB_PATH';

/** Default durable SQLite location for LOCAL CLI agent sessions, so `agent
 *  session start/turn` persist across CLI invocations at parity with the
 *  remote server (T-MTA-05). Operators can override via AGENT_SESSION_DB_PATH. */
function defaultLocalSessionDbPath(): string {
  return join(homedir(), '.wine-search-engine', 'agent-sessions.sqlite');
}

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

    // Ensure a durable session store is available for local `agent session *`
    // commands. If the operator has not pinned a path, default to a file under
    // the user's home dir (created on demand). Restored in `finally`.
    const previousSessionDbPath = process.env[AGENT_SESSION_DB_PATH_ENV];
    let setSessionDbPath = false;
    if (previousSessionDbPath === undefined || previousSessionDbPath.length === 0) {
      const dbPath = defaultLocalSessionDbPath();
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
        process.env[AGENT_SESSION_DB_PATH_ENV] = dbPath;
        setSessionDbPath = true;
      } catch (err) {
        // Intentional: could not create the data dir — leave sessions
        // fail-closed (the facade surfaces a clear "unavailable" error).
        // Single-shot run still works without a store.
        void err;
      }
    }
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
    // Hoisted so `finally` can finalize the durable SQLite session store
    // (checkpoint WAL + close handle) — otherwise each CLI invocation leaks an
    // fd / leaves an unbounded WAL.
    let sessionStore: { close?(): void } | undefined;
    try {
      const container = await createContainer(config, managedRuntime);
      sessionStore = container.wineSearch?.agentSessionStore;
      return await work(container);
    } finally {
      sessionStore?.close?.();
      await managedRuntime.close();
      bootstrapLogger.level = previousLevel;
      if (previousObservabilityGate === undefined) {
        delete process.env.WINE_CLI_SUPPRESS_OBSERVABILITY_LOGS;
      } else {
        process.env[CLI_SUPPRESS_OBSERVABILITY_LOGS_ENV] = previousObservabilityGate;
      }
      if (setSessionDbPath) {
        delete process.env.AGENT_SESSION_DB_PATH;
      }
    }
  }
}
