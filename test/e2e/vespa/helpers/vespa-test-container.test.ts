import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let searchUseCaseDeps: unknown;
let hybridUseCaseDeps: unknown;
let ltrModelRegistryCalls = 0;

vi.mock('pg', () => {
  const MockPool = vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  }));

  return { Pool: MockPool };
});

vi.mock('../../../../src/application/search/search.usecase.js', () => {
  const MockSearchUseCase = vi.fn().mockImplementation((deps: unknown) => {
    searchUseCaseDeps = deps;
    return {
      execute: vi.fn(),
    };
  });

  return { SearchUseCase: MockSearchUseCase };
});

vi.mock('../../../../src/application/search/hybrid.usecase.js', () => {
  const MockHybridUseCase = vi.fn().mockImplementation((deps: unknown) => {
    hybridUseCaseDeps = deps;
    return {
      execute: vi.fn(),
    };
  });

  return { HybridUseCase: MockHybridUseCase };
});

vi.mock('../../../../src/infrastructure/adapter/pg-ltr-model-registry.js', () => {
  const MockPgLtrModelRegistry = vi.fn().mockImplementation(() => ({
    getAllModels: async (): Promise<ReadonlyMap<string, unknown>> => {
      ltrModelRegistryCalls += 1;
      return new Map([
        [
          'known_item',
          {
            queryClass: 'known_item',
            weights: [1, 0, 0, 0, 0, 0, 0, 0],
            bias: 0,
            trainingExampleCount: 1,
            ndcg5ValidationScore: 1,
            trainedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      ]);
    },
  }));

  return { PgLtrModelRegistry: MockPgLtrModelRegistry };
});

describe('createVespaTestContainer', () => {
  beforeEach(() => {
    searchUseCaseDeps = undefined;
    hybridUseCaseDeps = undefined;
    ltrModelRegistryCalls = 0;
    vi.stubEnv('TEST_DB_URL', 'postgres://example.test/vespa');
    vi.stubEnv('PG_TEST_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes the production parity wiring into both search and hybrid use cases', async () => {
    const { createVespaTestContainer } = await import('./vespa-test-container.js');

    const parts = await createVespaTestContainer();

    expect(parts.container.searchUseCase).toBeDefined();
    expect(parts.container.hybridUseCase).toBeDefined();
    expect(ltrModelRegistryCalls).toBe(1);
    expect(searchUseCaseDeps).toEqual(expect.objectContaining({
      snapshotVersions: expect.any(Object),
      querySanitizer: expect.any(Object),
      injectionJudge: expect.any(Object),
      ltrModels: expect.any(Map),
    }));
    expect(hybridUseCaseDeps).toEqual(expect.objectContaining({
      snapshotVersions: expect.any(Object),
      querySanitizer: expect.any(Object),
      injectionJudge: expect.any(Object),
      ltrModels: expect.any(Map),
    }));
    await parts.close();
  });
});
