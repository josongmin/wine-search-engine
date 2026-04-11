import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';
import type { RuntimeSupportServices } from '../container-runtime-support.js';

const adapters = {
  searchIndex: { getDocument: vi.fn() },
  embeddingService: {},
  reranker: {},
};

const support: RuntimeSupportServices = {
  querySanitizer: { sanitize: vi.fn() } as RuntimeSupportServices['querySanitizer'],
  injectionJudge: undefined,
  cacheService: undefined,
  ltrModels: new Map(),
  drinkingWindowPredictor: {
    modelVersion: 'test-model',
    predict: vi.fn(),
  } as RuntimeSupportServices['drinkingWindowPredictor'],
};

const planner = { plan: vi.fn() };
const entityResolver = { resolve: vi.fn() };
const candidatePool = { generate: vi.fn() };
const browseRetriever = { browseProducer: vi.fn(), browseRegion: vi.fn() };
const compareRetriever = { compareAgainstAnchor: vi.fn() };
const baseRanker = { rank: vi.fn() };
const rankingPipeline = { rank: vi.fn(), getLastFunnelMetrics: vi.fn() };
const decisionEngine = { decide: vi.fn() };
const responseBuilder = { build: vi.fn() };
const mixedSolver = { solve: vi.fn() };

const buildCoreAdapterServices = vi.fn(() => adapters);
const buildRuntimeSupportServices = vi.fn(async () => support);
const buildQueryPlanner = vi.fn(async () => planner);
const buildEntityResolver = vi.fn(() => entityResolver);
const buildCandidatePool = vi.fn(() => candidatePool);
const buildBrowseRetriever = vi.fn(() => browseRetriever);
const buildCompareRetriever = vi.fn(() => compareRetriever);
const buildRanker = vi.fn(() => baseRanker);
const buildRankingPipeline = vi.fn(() => rankingPipeline);
const buildSnapshotVersions = vi.fn(() => ({
  modelVersions: {},
  indexVersions: {},
  featureFlags: {},
}));
const buildDecisionEngine = vi.fn(() => decisionEngine);
const buildMixedSolver = vi.fn(() => mixedSolver);
const buildResponseBuilder = vi.fn(() => responseBuilder);
const buildBlockingUseCaseAdapter = vi.fn(() => ({ block: vi.fn() }));

vi.mock('../container-adapters.js', () => ({
  buildCoreAdapterServices,
}));

vi.mock('../startup-preflight.js', () => ({
  warnStartupMisconfigurations: vi.fn(),
}));

vi.mock('../container-runtime-support.js', () => ({
  buildRuntimeSupportServices,
}));

vi.mock('../container-core-builders.js', () => ({
  buildBlockingUseCaseAdapter,
  buildCandidatePool,
  buildBrowseRetriever,
  buildCompareRetriever,
  buildEntityResolver,
  buildQueryPlanner,
  buildRanker,
  buildRankingPipeline,
  buildSnapshotVersions,
  buildDecisionEngine,
  buildMixedSolver,
  buildResponseBuilder,
}));

describe('buildCoreContainerServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires ranking pipeline for both public search and mixed solver', async () => {
    const { buildCoreContainerServices } = await import('../container-core.js');
    const config = parseEnv({ NODE_ENV: 'test' });

    const core = await buildCoreContainerServices(config);

    expect(buildRuntimeSupportServices).toHaveBeenCalledWith(config, {});
    expect(buildCoreAdapterServices).toHaveBeenCalledWith(config, undefined);
    expect(buildRanker).toHaveBeenCalledWith(adapters, config, support);
    expect(buildRankingPipeline).toHaveBeenCalledWith(baseRanker);
    expect(buildMixedSolver).toHaveBeenCalledWith(adapters, rankingPipeline);
    expect(core.ranker).toBe(rankingPipeline);
    expect(core.mixedSolver).toBe(mixedSolver);
  });

  it('RCA-03: calls warnStartupMisconfigurations with config before building services', async () => {
    const { buildCoreContainerServices } = await import('../container-core.js');
    const { warnStartupMisconfigurations } = await import('../startup-preflight.js');
    const config = parseEnv({ NODE_ENV: 'test' });

    await buildCoreContainerServices(config);

    expect(warnStartupMisconfigurations).toHaveBeenCalledOnce();
    expect(warnStartupMisconfigurations).toHaveBeenCalledWith(config);
    // Must run before buildRuntimeSupportServices so warnings appear even if
    // runtime service construction throws.
    const warnOrder = vi.mocked(warnStartupMisconfigurations).mock.invocationCallOrder[0];
    const supportOrder = vi.mocked(buildRuntimeSupportServices).mock.invocationCallOrder[0];
    expect(warnOrder).toBeLessThan(supportOrder!);
  });
});
