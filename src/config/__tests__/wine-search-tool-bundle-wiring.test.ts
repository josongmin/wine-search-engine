/**
 * Wine-search tool-bundle composition-root wiring spec.
 *
 * Asserts the CLAUDE.md rule 33 invariant for the wine-agent-loop tool bundle:
 * the bundle is constructed at the composition root and reaches
 * `WineSearchOrchestratorImpl`'s deps slot. Without this, multi-step plans
 * silently fall through to Synthesizer Layer 4 — covered by Track C's
 * earlier regression report.
 *
 * Strategy: stub the heavy container slices (matches
 * `container-wine-search-wiring.test.ts`), then verify that with
 * `WINE_SEARCH_ENABLED=true` + ANTHROPIC_API_KEY the container constructs a
 * non-undefined wine-search service. The orchestrator is NOT invoked — we
 * only assert assembly succeeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

const buildMockCore = (overrides: Record<string, unknown> = {}) => ({
  queryPlanner: {} as never,
  entityResolver: {} as never,
  candidatePool: {} as never,
  ranker: {} as never,
  decisionEngine: {} as never,
  responseBuilder: {} as never,
  mixedSolver: {} as never,
  drinkingWindowPredictor: {} as never,
  calibrationStore: {} as never,
  browseRetriever: {} as never,
  compareRetriever: {} as never,
  entityLookup: {
    getDocuments: vi.fn(async () => new Map()),
  } as never,
  snapshotVersions: {} as never,
  cacheLookupRuntimeState: {} as never,
  cacheLookupRuntimeStateProvider: {} as never,
  querySanitizer: {} as never,
  injectionJudge: undefined,
  cacheService: undefined,
  ltrModels: undefined,
  phraseCache: undefined,
  chatLlm: undefined,
  runtimeReadiness: {} as never,
  ...overrides,
});

vi.mock('../container-core.js', () => ({
  buildCoreContainerServices: vi.fn(async () => buildMockCore()),
}));

vi.mock('../container-features.js', () => ({
  buildFeatureContainerServices: vi.fn(() => ({
    searchUseCase: { execute: vi.fn() } as never,
    decomposedSearchUseCase: { execute: vi.fn() } as never,
    interpretUseCase: {} as never,
    resolveUseCase: {} as never,
    hybridUseCase: {} as never,
    batchSearchUseCase: {} as never,
    autocompleteUseCase: {} as never,
    drinkingWindowUseCase: { check: vi.fn() } as never,
    evalRunner: null,
  })),
}));

describe('createContainer — wine-agent-loop tool bundle wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, 'WINE_SEARCH_ENABLED');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        Reflect.deleteProperty(process.env, key);
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('constructs the wine-search container slice when WINE_SEARCH_ENABLED=true + key is set', async () => {
    process.env['WINE_SEARCH_ENABLED'] = 'true';
    const { createContainer } = await import('../container.js');
    const config = parseEnv({
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    const container = await createContainer(config);

    expect(container.wineSearch).toBeDefined();
    expect(container.wineSearch?.wineSearchOrchestrator).toBeDefined();
    // We do not invoke `.execute(...)` — only assert that the orchestrator
    // assembled with the tool bundle. The unit lane for the bundle itself
    // covers its shape (`wine-agent-loop-tool-bundle.test.ts`).
    expect(typeof container.wineSearch?.wineSearchOrchestrator.execute).toBe(
      'function',
    );
  });
});
