import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeVespaTestServer,
  createVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';
import { startFakeMlService, type FakeMlService } from './helpers/fake-ml-service.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { TEST_DOCUMENTS } from '../../integration/helpers/test-fixtures.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';
import {
  classifySearchFixtureMode,
  isFullRuntimeSearchReplayFixture,
  loadSearchReplayFixtures,
  runSearchFixture,
  type SearchReplayFixtureFile,
} from '../../replay-fixtures/search/run-search-fixture.js';
import {
  WINES as SEEDED_WINES,
  applyDefaultDrinkingWindowModelVersion,
} from '../../../scripts/seed-wines-real.js';

const HTTP_TIMEOUT_MS = 50;
const OPUS_ONE_2018_ID = createEntityId('opus-one-2018');
const FULL_RUNTIME_DETERMINISTIC_DOC_ID = createEntityId('full-runtime-deterministic-cabernet-2018');
const FULL_RUNTIME_REPORT_PATH = process.env['REPLAY_FULL_RUNTIME_REPORT_PATH'];
const FULL_RUNTIME_DETERMINISTIC_PREDICTOR = {
  modelVersion: 'deterministic:full-runtime-fixture',
  predict: () => ({
    drinkingWindowStart: 2024,
    drinkingWindowEnd: 2032,
    peakYear: 2028,
    confidence: 'medium' as const,
    modelVersion: 'deterministic:full-runtime-fixture',
  }),
};
const FULL_RUNTIME_LEARNED_DRINKING_WINDOW_MODEL_VERSION = 'learned-v1.0-full-runtime';
const SEEDED_FULL_RUNTIME_WINES = applyDefaultDrinkingWindowModelVersion(SEEDED_WINES);
const FULL_RUNTIME_DETERMINISTIC_DOCUMENT: RetrievalDocument = {
  ...SEEDED_FULL_RUNTIME_WINES.find((doc) => doc.entityId === OPUS_ONE_2018_ID)!,
  entityId: FULL_RUNTIME_DETERMINISTIC_DOC_ID,
  canonicalLabel: 'Full Runtime Deterministic Cabernet 2018',
  aliasesIdentitySafe: ['Full Runtime Deterministic Cabernet 2018'],
  aliasesNoisyRecall: ['full runtime deterministic cabernet', 'deterministic cabernet 2018'],
  searchTextKo: '풀 런타임 디터미니스틱 카베르네 2018 리플레이 전용 카베르네 소비뇽 와인',
  searchTextEn: 'full runtime deterministic cabernet 2018 replay only cabernet sauvignon wine',
  semanticSummary:
    'Replay-only Cabernet fixture for the full-runtime deterministic drinking-window lane.',
  drinkingWindowStart: undefined,
  drinkingWindowEnd: undefined,
  drinkingWindowModelVersion: undefined,
};

async function expectHttpJsonOk(
  responsePromise: Promise<Response>,
): Promise<void> {
  const response = await responsePromise;
  expect(response.ok).toBe(true);
}

async function probeFullRuntimeDependencies(
  fakeMlService: FakeMlService,
): Promise<void> {
  await expectHttpJsonOk(fetch(`${fakeMlService.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: ['full-runtime-probe'],
      model: 'vespa-e2e-test',
    }),
  }));

  await expectHttpJsonOk(fetch(`${fakeMlService.baseUrl}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: '오푸스원',
      candidates: [{ entity_id: 'opus-one-2018', label: 'Opus One 2018' }],
    }),
  }));

  await expectHttpJsonOk(fetch(`${fakeMlService.baseUrl}/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: '샴페인 와인 추천',
      texts: ['champagne recommendation'],
    }),
  }));
}

function buildFixtureDocuments(
  fixture: SearchReplayFixtureFile,
): readonly RetrievalDocument[] {
  if (fixture.requires_runtime_capability?.includes('drinking_window_runtime')) {
    return [FULL_RUNTIME_DETERMINISTIC_DOCUMENT];
  }

  return TEST_DOCUMENTS.map((doc) => ({
    ...doc,
    drinkingWindowStart: doc.drinkingWindowStart ?? 2024,
    drinkingWindowEnd: doc.drinkingWindowEnd ?? 2032,
    drinkingWindowModelVersion:
      doc.drinkingWindowModelVersion ?? FULL_RUNTIME_LEARNED_DRINKING_WINDOW_MODEL_VERSION,
  }));
}

async function resetCorpusForFixture(
  server: VespaTestServer,
  fixture: SearchReplayFixtureFile,
): Promise<void> {
  const idsToDelete = new Set<string>([
    ...SEEDED_FULL_RUNTIME_WINES.map((doc) => String(doc.entityId)),
    ...TEST_DOCUMENTS.map((doc) => String(doc.entityId)),
    String(FULL_RUNTIME_DETERMINISTIC_DOC_ID),
  ]);

  await Promise.all(
    [...idsToDelete].map(async (docId) => server.parts.vespaClient.delete(docId)),
  );

  if (fixture.requires_runtime_capability?.includes('drinking_window_runtime')) {
    await server.parts.vespaSearchIndex.bulkUpsert([FULL_RUNTIME_DETERMINISTIC_DOCUMENT]);
    return;
  }

  await server.parts.vespaSearchIndex.bulkUpsert(SEEDED_FULL_RUNTIME_WINES);
  await server.parts.vespaSearchIndex.bulkUpsert(buildFixtureDocuments(fixture));
}

function configureFullRuntimeFailure(
  fixture: SearchReplayFixtureFile,
  fakeMlService: FakeMlService,
): void {
  if (fixture.requires_runtime_capability?.includes('learned_matcher_runtime')) {
    fakeMlService.setDelay('/match', HTTP_TIMEOUT_MS + 100);
  }
  if (fixture.requires_runtime_capability?.includes('reranker_runtime')) {
    fakeMlService.setDelay('/rerank', HTTP_TIMEOUT_MS + 100);
  }
}

describe.skipIf(!HAS_REACHABLE_VESPA)('Vespa E2E — replay full-runtime fixtures', () => {
  let server: VespaTestServer | undefined;
  let fakeMlService: FakeMlService | undefined;
  const executionReport: Array<{
    fixture: string;
    runtimeMode: 'full_runtime';
    usedLiveSnapshot: boolean;
    executionMode: string;
    degradationReasons: readonly string[];
    capabilities: readonly string[];
  }> = [];

  const fullRuntimeFixtures = loadSearchReplayFixtures().filter(({ fixture }) =>
    isFullRuntimeSearchReplayFixture(fixture));

  beforeAll(async () => {
    fakeMlService = await startFakeMlService();
    server = await createVespaTestServer({
      mlServiceBaseUrl: fakeMlService.baseUrl,
      mlServiceHttpTimeoutMs: HTTP_TIMEOUT_MS,
      rerankThreshold: 0,
      killSwitchLearning: true,
      drinkingWindowPredictor: FULL_RUNTIME_DETERMINISTIC_PREDICTOR,
    });
    await server.parts.seedAlias('오푸스원', OPUS_ONE_2018_ID, 0.99);
    await probeFullRuntimeDependencies(fakeMlService);
  });

  beforeEach(() => {
    fakeMlService?.clearRequests();
    fakeMlService?.clearFailures();
    fakeMlService?.clearDelays();
  });

  afterAll(async () => {
    if (FULL_RUNTIME_REPORT_PATH !== undefined) {
      fs.mkdirSync(path.dirname(FULL_RUNTIME_REPORT_PATH), { recursive: true });
      fs.writeFileSync(
        FULL_RUNTIME_REPORT_PATH,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            fixture_count: executionReport.length,
            fixtures: executionReport,
          },
          null,
          2,
        ),
      );
    }
    if (server !== undefined) {
      await closeVespaTestServer(server);
    }
    await fakeMlService?.close();
  });

  it('keeps at least one full-runtime replay fixture in the dedicated lane', () => {
    expect(fullRuntimeFixtures.length).toBeGreaterThan(0);
    expect(fullRuntimeFixtures.every(({ fixture }) => fixture.metadata?.runtime_mode === 'full_runtime')).toBe(true);
  });

  for (const { file, fixture } of fullRuntimeFixtures) {
    it(`executes full-runtime replay fixture ${file}`, async () => {
      expect(server).toBeDefined();
      expect(fakeMlService).toBeDefined();
      configureFullRuntimeFailure(fixture, fakeMlService!);
      await resetCorpusForFixture(server!, fixture);

      const { response: body, assertionSummary, mode } = await runSearchFixture(fixture, {
        app: server!.app,
      });

      expect(mode).toBe(classifySearchFixtureMode(fixture));
      expect(assertionSummary.endpoint).toBe('/v1/search/replay');
      expect(assertionSummary.runtimeMode).toBe('full_runtime');
      expect(assertionSummary.usedLiveSnapshot).toBe(true);
      expect(assertionSummary.skipped).toBe(false);

      if ('error_code' in fixture.expected) {
        expect(assertionSummary.errorCode).toBe(fixture.expected.error_code);
        return;
      }

      expect(body).toBeDefined();
      expect(body?.meta.execution_mode).toBe(fixture.expected.execution_mode);
      expect(assertionSummary.degradationReasons).toEqual(fixture.expected.degradation_reasons);
      executionReport.push({
        fixture: file,
        runtimeMode: 'full_runtime',
        usedLiveSnapshot: assertionSummary.usedLiveSnapshot,
        executionMode: body!.meta.execution_mode ?? fixture.expected.execution_mode,
        degradationReasons: [...assertionSummary.degradationReasons ?? []],
        capabilities: [...fixture.requires_runtime_capability ?? []],
      });

      if (fixture.requires_runtime_capability?.includes('learned_matcher_runtime')) {
        expect(fakeMlService!.countRequests('/match')).toBeGreaterThan(0);
      }
      if (fixture.requires_runtime_capability?.includes('reranker_runtime')) {
        expect(fakeMlService!.countRequests('/rerank')).toBeGreaterThan(0);
      }
    });
  }
});
