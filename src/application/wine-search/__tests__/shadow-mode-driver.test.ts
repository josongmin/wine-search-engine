/**
 * Integration test for the shadow-mode driver — the staging bridge that
 * composes the real legacy + wine-search orchestrators from the production
 * container so the bench CLI can run a true end-to-end cutover validation.
 *
 * These tests exercise the driver WITHOUT booting the real container: they
 * inject a synthetic `buildContainer` and a synthetic `env` snapshot via the
 * documented test seams (`BuildShadowModeDriverOptions.buildContainer` / `.env`).
 * The pre-flight contract (flag + key + orchestrator presence) and the
 * shutdown lifecycle are the load-bearing behaviours under test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildShadowModeDriver,
  type ContainerBuildResult,
} from '../shadow-mode-driver.js';
import type { Container } from '../../../config/container.js';
import type { WineSearchResult } from '../wine-search-result-schemas.js';

const WINE_SEARCH_ENABLED_ENV = 'WINE_SEARCH_ENABLED';
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/** Env snapshot with both pre-flight gates satisfied. */
function readyEnv(): NodeJS.ProcessEnv {
  return {
    [WINE_SEARCH_ENABLED_ENV]: 'true',
    [ANTHROPIC_API_KEY_ENV]: 'sk-ant-test-key',
  };
}

/** A no-op WineSearchResult — enough to satisfy the structural orchestrator. */
function stubWineSearchResult(): WineSearchResult {
  return {
    answer: 'stub',
    layer: 'primary',
    groundedOnToolResults: false,
    toolOutcomes: [],
    executionSteps: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    totalDurationMs: 0,
    terminationReason: 'answer',
    policyBlocked: false,
    degradedReason: undefined,
    intent: 'search',
    planKind: 'single-search',
  };
}

interface SyntheticContainerOptions {
  readonly withAgentOrchestrator?: boolean;
  readonly withWineSearch?: boolean;
}

/**
 * Build a minimal structurally-valid Container with only the slots the driver
 * reads (`agentOrchestrator`, `wineSearch.wineSearchOrchestrator`). Cast through
 * `unknown` is confined to test scaffolding — the driver only ever touches the
 * two fields populated here.
 */
function syntheticContainer(opts: SyntheticContainerOptions = {}): Container {
  const agentOrchestrator = opts.withAgentOrchestrator === false
    ? undefined
    : { execute: async () => ({ answer: 'legacy-stub' }) };
  const wineSearch = opts.withWineSearch === false
    ? undefined
    : {
        wineSearchOrchestrator: {
          execute: async (): Promise<WineSearchResult> => stubWineSearchResult(),
        },
      };
  return { agentOrchestrator, wineSearch } as unknown as Container;
}

function syntheticBuildContainer(
  opts: SyntheticContainerOptions = {},
): { build: () => Promise<ContainerBuildResult>; closeSpy: ReturnType<typeof vi.fn> } {
  const closeSpy = vi.fn(async () => {});
  const build = async (): Promise<ContainerBuildResult> => ({
    container: syntheticContainer(opts),
    close: closeSpy,
  });
  return { build, closeSpy };
}

describe('buildShadowModeDriver — pre-flight gates', () => {
  it('throws a flag-named error when WINE_SEARCH_ENABLED is not "true"', async () => {
    const { build } = syntheticBuildContainer();
    await expect(
      buildShadowModeDriver({
        env: { [ANTHROPIC_API_KEY_ENV]: 'sk-ant-test-key' },
        buildContainer: build,
      }),
    ).rejects.toThrow(/WINE_SEARCH_ENABLED/u);
  });

  it('throws an API-key-named error when ANTHROPIC_API_KEY is missing', async () => {
    const { build } = syntheticBuildContainer();
    await expect(
      buildShadowModeDriver({
        env: { [WINE_SEARCH_ENABLED_ENV]: 'true' },
        buildContainer: build,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  it('throws an API-key error when ANTHROPIC_API_KEY is empty string', async () => {
    const { build } = syntheticBuildContainer();
    await expect(
      buildShadowModeDriver({
        env: { [WINE_SEARCH_ENABLED_ENV]: 'true', [ANTHROPIC_API_KEY_ENV]: '' },
        buildContainer: build,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/u);
  });

  it('does NOT build the container when the flag pre-flight fails (short-circuit)', async () => {
    const buildSpy = vi.fn(async (): Promise<ContainerBuildResult> => ({
      container: syntheticContainer(),
    }));
    await expect(
      buildShadowModeDriver({ env: {}, buildContainer: buildSpy }),
    ).rejects.toThrow(/WINE_SEARCH_ENABLED/u);
    expect(buildSpy).not.toHaveBeenCalled();
  });
});

describe('buildShadowModeDriver — container-slot validation', () => {
  it('throws (and closes) when agentOrchestrator is undefined', async () => {
    const { build, closeSpy } = syntheticBuildContainer({ withAgentOrchestrator: false });
    await expect(
      buildShadowModeDriver({ env: readyEnv(), buildContainer: build }),
    ).rejects.toThrow(/agentOrchestrator/u);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('throws (and closes) when the wineSearch slice is undefined', async () => {
    const { build, closeSpy } = syntheticBuildContainer({ withWineSearch: false });
    await expect(
      buildShadowModeDriver({ env: readyEnv(), buildContainer: build }),
    ).rejects.toThrow(/wineSearch/u);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildShadowModeDriver — happy path', () => {
  it('exposes both raw orchestrators + a runner', async () => {
    const { build } = syntheticBuildContainer();
    const driver = await buildShadowModeDriver({ env: readyEnv(), buildContainer: build });
    expect(driver.runner).toBeDefined();
    expect(driver.legacyOrchestrator).toBeDefined();
    expect(driver.wineSearchOrchestrator).toBeDefined();
    expect(typeof driver.wineSearchOrchestrator.execute).toBe('function');
    await driver.shutdown();
  });

  it('leaves scorer undefined when no benchScorer is supplied', async () => {
    const { build } = syntheticBuildContainer();
    const driver = await buildShadowModeDriver({ env: readyEnv(), buildContainer: build });
    expect(driver.scorer).toBeUndefined();
    await driver.shutdown();
  });

  it('builds a scorer when a benchScorer fn is supplied', async () => {
    const { build } = syntheticBuildContainer();
    const benchScorer = vi.fn();
    const driver = await buildShadowModeDriver({
      env: readyEnv(),
      buildContainer: build,
      // The scorer fn signature is structural; the driver only stores it.
      benchScorer: benchScorer as never,
    });
    expect(driver.scorer).toBeDefined();
    await driver.shutdown();
  });

  it('the exposed wineSearchOrchestrator delegates to the container instance', async () => {
    const { build } = syntheticBuildContainer();
    const driver = await buildShadowModeDriver({ env: readyEnv(), buildContainer: build });
    const result = await driver.wineSearchOrchestrator.execute({
      query: '와인 추천해줘',
      requestId: 'test-req',
    });
    expect(result.answer).toBe('stub');
    await driver.shutdown();
  });
});

describe('buildShadowModeDriver — shutdown lifecycle', () => {
  it('shutdown() invokes the container close() exactly once', async () => {
    const { build, closeSpy } = syntheticBuildContainer();
    const driver = await buildShadowModeDriver({ env: readyEnv(), buildContainer: build });
    await driver.shutdown();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('shutdown() is idempotent — repeated calls close at most once', async () => {
    const { build, closeSpy } = syntheticBuildContainer();
    const driver = await buildShadowModeDriver({ env: readyEnv(), buildContainer: build });
    await driver.shutdown();
    await driver.shutdown();
    await driver.shutdown();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
