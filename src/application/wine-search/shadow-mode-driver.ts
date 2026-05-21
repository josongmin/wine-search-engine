/**
 * Shadow-mode driver: composes the real `AgentOrchestrator` and
 * `WineSearchOrchestrator` from the production container so the bench CLI
 * (`scripts/wine-search/run-shadow-mode-bench.ts`) can drive a true end-to-end
 * cutover validation (live Anthropic + live Vespa).
 *
 * This module is **script-only**: it is the staging bridge between the
 * production composition root (`src/config/container.ts`) and the shadow-mode
 * harness. It MUST NOT be imported from request-path code — both
 * orchestrators are already wired into Fastify routes via the regular
 * `Container`, and re-importing through this driver would build a second copy
 * of the LLM client / circuit breakers.
 *
 * Production wiring contract (CLAUDE.md rule 33):
 *   - The driver is imported by `scripts/wine-search/run-shadow-mode-bench.ts`
 *     when the CLI is invoked with `--composition-root`. That counts as the
 *     production import for the rule-33 grep: foundation code is not allowed
 *     to ship un-imported.
 *
 * Operator pre-flight (cannot be silently fixed — driver throws):
 *   - `WINE_SEARCH_ENABLED=true` (env). Without the flag the container does
 *     not build the new orchestrator slice; we refuse to run the bench
 *     against a stub-shaped void.
 *   - `ANTHROPIC_API_KEY` set. Without it the container itself would throw
 *     during `buildWineSearchContainerServices`; we re-surface a friendlier
 *     error before the container build even starts so the operator gets a
 *     single-line actionable failure.
 *
 * Lifecycle:
 *   - `buildShadowModeDriver({ ... })` is async (the container build is async).
 *   - The returned `ShadowModeDriver` exposes `shutdown()` which closes the
 *     PG pool / Redis client / OpenTelemetry SDK that the container opened.
 *     The CLI MUST `await driver.shutdown()` at the end of the run.
 *
 * Test seam:
 *   - `BuildShadowModeDriverOptions.buildContainer` accepts an injected
 *     container builder so the integration test can pin a synthetic
 *     `Container` without spinning up the real composition root.
 */

import { ShadowModeRunner } from './shadow-mode-runner.js';
import type {
  ShadowModeLogger,
  WineSearchOrchestratorLike,
} from './shadow-mode-runner.js';
import type { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import {
  ShadowModeScorer,
  type BenchScorerFn,
} from './shadow-mode-scoring.js';
import type { Container } from '@config/container.js';
import { WINE_SEARCH_FEATURE_FLAG_ENV } from '@config/wine-search-feature-flag.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/**
 * Canonical env-var name for the Anthropic key. Importers MUST reference this
 * constant — never the literal string — so grep-driven audits find every
 * read site. Matches the name validated in `src/config/env.ts`.
 */
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Docs anchor surfaced in every error message so the operator has a
 * documented next-step. Points at the runbook section that lists the full
 * staging pre-flight (Vespa health, quota, etc).
 */
const CUTOVER_RUNBOOK_PATH = 'docs/runbook-wine-search-cutover.md';

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

export interface ShadowModeDriver {
  /** Shadow-mode runner wired to the real legacy and new orchestrators. */
  readonly runner: ShadowModeRunner;
  /**
   * The real legacy orchestrator pulled from the container. Exposed so the
   * bench CLI's `runBench()` — which builds its own runner internally — can
   * consume the raw orchestrators without the driver and the CLI each owning
   * an independent runner. The driver's `runner` and the CLI's runner wrap the
   * SAME orchestrator instances, so there is no duplicate LLM client.
   */
  readonly legacyOrchestrator: AgentOrchestrator;
  /** The real wine-search orchestrator (structural adapter) from the container. */
  readonly wineSearchOrchestrator: WineSearchOrchestratorLike;
  /**
   * Shadow-mode scorer wrapping the runner with the bench scorer. The CLI
   * supplies the scorer fn (loaded dynamically from `test/benchmark/agent`)
   * via {@link BuildShadowModeDriverOptions.benchScorer}; this property is
   * `undefined` when scoring was not requested.
   */
  readonly scorer: ShadowModeScorer | undefined;
  /**
   * Close the underlying container resources (PG pool, Redis, telemetry).
   * Safe to call multiple times — the underlying `managedRuntime.close()`
   * memoises the first call (`closePromise`).
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

/**
 * Result returned by an injected container builder. The default builder
 * constructs the full production container plus the runtime handle bag that
 * owns the PG / Redis / telemetry connections so `shutdown()` can release
 * them deterministically.
 */
export interface ContainerBuildResult {
  readonly container: Container;
  /** Optional closer invoked from {@link ShadowModeDriver.shutdown}. */
  close?(): Promise<void>;
}

export interface BuildShadowModeDriverOptions {
  /**
   * Container builder override — defaults to the real composition root.
   * Tests pass a synthetic builder that returns a hand-crafted `Container`
   * without booting Postgres / Redis. The builder MUST return both a
   * `container` and (optionally) a `close()` so the driver can release
   * resources at shutdown.
   */
  readonly buildContainer?: () => Promise<ContainerBuildResult>;
  /**
   * Bench scorer fn. When provided, the driver also constructs a
   * `ShadowModeScorer`; when undefined the scorer slot is left empty (the
   * CLI runs the runner only).
   */
  readonly benchScorer?: BenchScorerFn;
  /**
   * Logger forwarded to the runner. Defaults to a noop logger — the CLI
   * normally injects a console-backed logger.
   */
  readonly logger?: ShadowModeLogger;
  /**
   * Env snapshot used for pre-flight checks. Defaults to `process.env`. Test
   * seam so the integration test can simulate missing env vars without
   * mutating the real `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// buildShadowModeDriver
// ---------------------------------------------------------------------------

/**
 * Compose `ShadowModeRunner` (and optionally `ShadowModeScorer`) from the
 * production container. Throws with operator-facing messages when the
 * environment is not ready.
 *
 * The returned driver holds references to the container — call
 * `driver.shutdown()` exactly once when the bench run completes so PG /
 * Redis / OTel are released cleanly.
 */
export async function buildShadowModeDriver(
  options: BuildShadowModeDriverOptions = {},
): Promise<ShadowModeDriver> {
  const env = options.env ?? process.env;

  // ── Pre-flight 1: feature flag. The container also enforces this, but
  //    surfacing a friendly error BEFORE the container build saves a long
  //    PG / Redis / telemetry initialization on a misconfigured machine.
  if (env[WINE_SEARCH_FEATURE_FLAG_ENV] !== 'true') {
    throw new Error(
      `[shadow-mode-driver] ${WINE_SEARCH_FEATURE_FLAG_ENV} must be set to "true" before running the `
      + `bench against the real container — the WineSearchOrchestrator is only built when the flag `
      + `is on. See ${CUTOVER_RUNBOOK_PATH} for the full pre-flight checklist.`,
    );
  }

  // ── Pre-flight 2: Anthropic credential. Same rationale as above —
  //    short-circuit before the heavyweight container build.
  if (env[ANTHROPIC_API_KEY_ENV] === undefined || env[ANTHROPIC_API_KEY_ENV] === '') {
    throw new Error(
      `[shadow-mode-driver] ${ANTHROPIC_API_KEY_ENV} is not set — the bench cannot reach Anthropic. `
      + `Export the key in your shell or .env.local before running with --composition-root. `
      + `See ${CUTOVER_RUNBOOK_PATH}.`,
    );
  }

  // ── Build the container. Default builder constructs the real composition
  //    root, including PG pool / Redis client / telemetry SDK.
  const built = await (options.buildContainer ?? defaultBuildContainer)();
  const container = built.container;

  // ── Pre-flight 3: agentOrchestrator present (AGENT_ENABLED=true gate).
  if (container.agentOrchestrator === undefined) {
    await safeClose(built.close?.bind(built));
    throw new Error(
      `[shadow-mode-driver] container.agentOrchestrator is undefined — set AGENT_ENABLED=true and `
      + `configure an OpenAI credential so the legacy agent route is wired. The bench requires both `
      + `legacy and new orchestrators. See ${CUTOVER_RUNBOOK_PATH}.`,
    );
  }

  // ── Pre-flight 4: wineSearch slice present. The container omits this slot
  //    when the feature flag is off OR the Anthropic key is missing — both
  //    are checked above, but a defensive re-check guards against a future
  //    container change that silently drops the slot.
  const wineSearchSlice = container.wineSearch;
  if (wineSearchSlice === undefined) {
    await safeClose(built.close?.bind(built));
    throw new Error(
      `[shadow-mode-driver] container.wineSearch is undefined despite ${WINE_SEARCH_FEATURE_FLAG_ENV}=true. `
      + `Check that buildWineSearchContainerServices() ran successfully — see container.ts. `
      + `Pre-flight reference: ${CUTOVER_RUNBOOK_PATH}.`,
    );
  }

  // ── Wrap the real orchestrator in a structural adapter so the shadow-mode
  //    runner accepts it. The wine-search orchestrator's `execute()`
  //    signature already matches `WineSearchOrchestratorLike`; the adapter
  //    exists purely to make the structural contract explicit at the seam
  //    (and to anchor a future input-shape change to a single edit point).
  const wineSearchAdapter: WineSearchOrchestratorLike = {
    execute: (input) => wineSearchSlice.wineSearchOrchestrator.execute(input),
  };

  const runner = new ShadowModeRunner({
    legacyOrchestrator: container.agentOrchestrator,
    wineSearchOrchestrator: wineSearchAdapter,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const scorer = options.benchScorer === undefined
    ? undefined
    : new ShadowModeScorer({ runner, scorer: options.benchScorer });

  let shutdownInvoked = false;
  return {
    runner,
    scorer,
    legacyOrchestrator: container.agentOrchestrator,
    wineSearchOrchestrator: wineSearchAdapter,
    async shutdown(): Promise<void> {
      if (shutdownInvoked) return;
      shutdownInvoked = true;
      await safeClose(built.close?.bind(built));
    },
  };
}

// ---------------------------------------------------------------------------
// Default container builder
//
// We import `createContainer` / `loadConfig` / runtime-handles factories
// LAZILY (dynamic import) so unit tests that pass an injected `buildContainer`
// never pay the cost of loading the full composition-root module graph
// (~hundreds of TS files). The dynamic import also keeps this module
// importable in script-only contexts where `process.env` might not yet be
// populated at module-load time.
// ---------------------------------------------------------------------------

async function defaultBuildContainer(): Promise<ContainerBuildResult> {
  const [{ loadConfig }, { createContainer }, runtimeMod, pgPoolMod, redisMod] =
    await Promise.all([
      import('@config/env.js'),
      import('@config/container.js'),
      import('@config/runtime-handles.js'),
      import('@infra/db/pg-pool.js'),
      import('@infra/db/redis-client.js'),
    ]);

  const config = loadConfig();
  const pool = pgPoolMod.shouldUsePgPool(config.pg) ? pgPoolMod.createPgPool(config.pg) : undefined;

  // Bench does not exercise the watchlist publish/subscribe paths, so we
  // omit the watchlist factory functions entirely — the container's
  // watchlist runtime degrades to `null` (mirroring the main entry point
  // when Redis is unavailable). This keeps the bench bootstrap dependency
  // surface as small as possible.
  let redisClient: Awaited<ReturnType<typeof redisMod.connectRedisClient>> | null = null;
  try {
    redisClient = await redisMod.connectRedisClient(config.redis);
  } catch {
    redisClient = null;
  }

  const runtimeHandles = {
    ...(pool !== undefined ? { pool } : {}),
    ...(redisClient !== null ? { redisClient } : {}),
  };

  const managedRuntime = runtimeMod.createManagedRuntimeHandles(runtimeHandles);
  const container = await createContainer(config, managedRuntime);

  return {
    container,
    async close(): Promise<void> {
      await managedRuntime.close();
    },
  };
}

async function safeClose(close: (() => Promise<void>) | undefined): Promise<void> {
  if (close === undefined) return;
  try {
    await close();
  } catch (err) {
    // Surface but do not throw — shutdown errors must not mask the bench
    // exit code. The error is written to stderr so operators can investigate
    // post-run.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[shadow-mode-driver] shutdown error (non-fatal): ${msg}\n`);
  }
}
