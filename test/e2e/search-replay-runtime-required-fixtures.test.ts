import { describe, expect, it } from 'vitest';
import type { DrinkingWindowPredictorPort } from '../../src/domain/drinking-window/port/drinking-window-predictor.port.js';
import type { RerankerPort } from '../../src/domain/ranking/port/reranker.port.js';
import type { LearnedMatcherPort } from '../../src/domain/resolver/port/learned-matcher.port.js';
import {
  closeTestServer,
  createTestServer,
  type TestServer,
} from './helpers/test-server.js';
import {
  classifySearchFixtureMode,
  isInMemoryRuntimeSearchReplayFixture,
  loadSearchReplayFixtures,
  runSearchFixture,
  type SearchReplayFixtureFile,
} from '../replay-fixtures/search/run-search-fixture.js';

function buildRuntimeLearnedMatcher(
  fixture: SearchReplayFixtureFile,
): LearnedMatcherPort | undefined {
  if (!fixture.requires_runtime_capability?.includes('learned_matcher_runtime')) {
    return undefined;
  }

  return {
    match: async () => {
      throw new Error('learned matcher timed out in replay runtime lane');
    },
  };
}

function buildRuntimeReranker(
  fixture: SearchReplayFixtureFile,
): RerankerPort | undefined {
  if (!fixture.requires_runtime_capability?.includes('reranker_runtime')) {
    return undefined;
  }

  return {
    rerank: async () => {
      throw new Error('reranker timed out in replay runtime lane');
    },
  };
}

function buildRuntimeDrinkingWindowPredictor(
  fixture: SearchReplayFixtureFile,
): DrinkingWindowPredictorPort | undefined {
  if (!fixture.requires_runtime_capability?.includes('drinking_window_runtime')) {
    return undefined;
  }

  return {
    modelVersion: 'deterministic:runtime-required-fixture',
    predict: () => ({
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2032,
      peakYear: 2028,
      confidence: 'medium',
      modelVersion: 'deterministic:runtime-required-fixture',
    }),
  };
}

describe('search replay fixtures — runtime-required HTTP lane', () => {
  const runtimeRequiredFixtures = loadSearchReplayFixtures().filter(({ fixture }) =>
    isInMemoryRuntimeSearchReplayFixture(fixture));

  it('keeps at least one runtime-required fixture in the executable runtime lane', () => {
    expect(runtimeRequiredFixtures.length).toBeGreaterThan(0);
    expect(runtimeRequiredFixtures.every(({ fixture }) => fixture.metadata?.runtime_mode === 'inmemory')).toBe(true);
  });

  for (const { file, fixture } of runtimeRequiredFixtures) {
    it(`executes runtime-required fixture ${file}`, async () => {
      const server: TestServer = await createTestServer({
        containerOptions: {
          learnedMatcher: buildRuntimeLearnedMatcher(fixture),
          reranker: buildRuntimeReranker(fixture),
          drinkingWindowPredictor: buildRuntimeDrinkingWindowPredictor(fixture),
          ...(fixture.requires_runtime_capability?.includes('drinking_window_runtime')
            ? { stripCachedDrinkingWindow: true }
            : {}),
          ...(fixture.requires_runtime_capability?.includes('drinking_window_runtime')
            ? { drinkingWindowModelVersionOverride: 'deterministic:runtime-required-fixture' }
            : {}),
          ...(fixture.requires_runtime_capability?.includes('reranker_runtime')
            ? { rerankThreshold: 0 }
            : {}),
        },
      });
      try {
        const { response: body, assertionSummary, mode } = await runSearchFixture(fixture, { app: server.app });
        expect(mode).toBe(classifySearchFixtureMode(fixture));
        expect(assertionSummary.endpoint).toBe(fixture.endpoint);
        expect(assertionSummary.runtimeMode).toBe('inmemory');
        expect(assertionSummary.usedLiveSnapshot).toBe(false);
        expect(assertionSummary.skipped).toBe(false);
        if ('error_code' in fixture.expected) {
          expect(assertionSummary.errorCode).toBe(fixture.expected.error_code);
          return;
        }

        expect(body).toBeDefined();
        expect(body?.meta.execution_mode).toBe(fixture.expected.execution_mode);
        expect(assertionSummary.degradationReasons).toEqual(fixture.expected.degradation_reasons);
      } finally {
        await closeTestServer(server);
      }
    });
  }
});
