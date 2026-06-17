import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
} from '../../../src/domain/ranking/service/lambdamart-ranker.js';

let searchUseCaseDeps: unknown;
let ltrModelRegistryCalls = 0;

vi.mock('pg', () => {
  const MockPool = vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  }));

  return { Pool: MockPool };
});

vi.mock('../../../src/application/search/search.usecase.js', () => {
  const MockSearchUseCase = vi.fn().mockImplementation((deps: unknown) => {
    searchUseCaseDeps = deps;
    return {
      execute: vi.fn(),
    };
  });

  return { SearchUseCase: MockSearchUseCase };
});

vi.mock('../../../src/infrastructure/adapter/pg-ltr-model-registry.js', () => {
  const MockPgLtrModelRegistry = vi.fn().mockImplementation(() => ({
    getAllModels: async (): Promise<ReadonlyMap<string, unknown>> => {
      ltrModelRegistryCalls += 1;
      return new Map([
        [
          'known_item',
          {
            queryClass: 'known_item',
            featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
            weights: Array.from({ length: LTR_FEATURE_DIMENSION }, (_, index) => (index === 0 ? 1 : 0)),
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
    ltrModelRegistryCalls = 0;
    vi.stubEnv('TEST_DB_URL', 'postgres://example.test/vespa');
    vi.stubEnv('PG_TEST_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes production parity wiring into SearchUseCase only (no dead hybrid container port)', async () => {
    const { createVespaTestContainer } = await import('../../e2e/vespa/helpers/vespa-test-container.js');

    const parts = await createVespaTestContainer();

    expect(parts.container.searchUseCase).toBeDefined();
    expect(parts.container).not.toHaveProperty('hybridUseCase');
    expect(parts.container).not.toHaveProperty('interpretUseCase');
    expect(parts.container).not.toHaveProperty('batchSearchUseCase');
    expect(ltrModelRegistryCalls).toBe(1);
    expect(searchUseCaseDeps).toEqual(expect.objectContaining({
      snapshotVersions: expect.any(Object),
      querySanitizer: expect.any(Object),
      injectionJudge: expect.any(Object),
      ltrModels: expect.any(Map),
    }));
    await parts.close();
  }, 30_000);
});
