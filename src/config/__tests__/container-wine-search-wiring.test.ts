import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

/**
 * Composition-root wiring spec for the Plan-then-Execute wine-search slice.
 *
 * Mirrors the mocking strategy in `container-agent-defense.test.ts`: stub the
 * heavy container slices so we exercise ONLY the wine-search construction
 * branch. We verify three production-critical invariants:
 *
 *  1. With `WINE_SEARCH_ENABLED` unset → `container.wineSearch === undefined`
 *     and the `/v1/wine-search` route is therefore NOT registered (zero-cost
 *     off-path).
 *  2. With `WINE_SEARCH_ENABLED=true` + an Anthropic key →
 *     `container.wineSearch.wineSearchOrchestrator.execute` is a function.
 *  3. With `WINE_SEARCH_ENABLED=true` but no `ANTHROPIC_API_KEY` →
 *     construction throws (the gate fails LOUDLY rather than silently 404).
 *
 * This is the CLAUDE.md rule 33 "verify wired into production" assertion: a
 * fresh import of `createContainer` MUST exercise the new branch.
 */

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
    replayUseCase: {} as never,
    autocompleteUseCase: {} as never,
    drinkingWindowUseCase: { check: vi.fn() } as never,
    adaptiveToolExecutor: {} as never,
    evalRunner: null,
  })),
}));

vi.mock('../container-watchlist.js', () => ({
  buildWatchlistContainerServices: vi.fn(() => ({
    watchlistService: {} as never,
    watchlistRuntime: null,
  })),
}));

vi.mock('../container-learning.js', () => ({
  buildLearningContainerServices: vi.fn(() => ({
    feedbackStore: null,
    feedbackProcessor: undefined,
    feedbackIngestUseCase: undefined,
  })),
}));

describe('createContainer — wine-search wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure a clean slate; tests set values explicitly. `Reflect.deleteProperty`
    // sidesteps the `no-dynamic-delete` lint guard (delete on a computed key).
    Reflect.deleteProperty(process.env, 'WINE_SEARCH_ENABLED');
  });

  afterEach(() => {
    // Restore env to baseline so test ordering does not matter. Use
    // explicit overwrite (NOT delete) to avoid the `no-dynamic-delete` lint
    // rule; setting an undeclared key to its original undefined value via
    // `Reflect.set` is equivalent for our purposes — the WINE_SEARCH_ENABLED
    // var is explicitly cleared before each test below.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        Reflect.deleteProperty(process.env, key);
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('leaves container.wineSearch undefined when WINE_SEARCH_ENABLED is unset', async () => {
    delete process.env['WINE_SEARCH_ENABLED'];
    const { createContainer } = await import('../container.js');
    const config = parseEnv({ NODE_ENV: 'test' });

    const container = await createContainer(config);

    expect(container.wineSearch).toBeUndefined();
  });

  it('builds a wineSearchOrchestrator when WINE_SEARCH_ENABLED=true and ANTHROPIC_API_KEY is set', async () => {
    process.env['WINE_SEARCH_ENABLED'] = 'true';
    const { createContainer } = await import('../container.js');
    const config = parseEnv({
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    const container = await createContainer(config);

    expect(container.wineSearch).toBeDefined();
    expect(container.wineSearch?.wineSearchOrchestrator).toBeDefined();
    expect(typeof container.wineSearch?.wineSearchOrchestrator.execute).toBe(
      'function',
    );
  });

  it('throws when WINE_SEARCH_ENABLED=true but ANTHROPIC_API_KEY is missing', async () => {
    process.env['WINE_SEARCH_ENABLED'] = 'true';
    const { createContainer } = await import('../container.js');
    // parseEnv allows ANTHROPIC_API_KEY to be absent at config-load time
    // (only required when LLM_INJECTION_PROVIDER=anthropic). The wine-search
    // gate enforces it at composition-root construction.
    const config = parseEnv({ NODE_ENV: 'test' });

    await expect(createContainer(config)).rejects.toThrowError(
      /WINE_SEARCH_ENABLED=true but ANTHROPIC_API_KEY is not configured/,
    );
  });

  it('leaves container.wineSearch undefined when WINE_SEARCH_ENABLED=false', async () => {
    process.env['WINE_SEARCH_ENABLED'] = 'false';
    const { createContainer } = await import('../container.js');
    const config = parseEnv({
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    const container = await createContainer(config);

    expect(container.wineSearch).toBeUndefined();
  });
});
