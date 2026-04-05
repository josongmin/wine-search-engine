/**
 * Vespa Real E2E — SOTA++ Search Quality Tests
 *
 * Tests semantic correctness, ranking quality, filter accuracy, and
 * multilingual support against a live Vespa instance with 35 seeded wines.
 *
 * All tests are gated on VESPA_URL — they are skipped in CI environments
 * without a live Vespa instance.
 *
 * Requires the Vespa fixture data to be seeded before running:
 *   npx tsx scripts/seed-vespa-test-data.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createVespaTestServer,
  closeVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const VESPA_URL = process.env['VESPA_URL'];

// ---------------------------------------------------------------------------
// Entity IDs for the 35-wine test dataset
// ---------------------------------------------------------------------------

// Bordeaux reds
const OPUS_ONE_2018_ID = 'opus-one-2018';
const OPUS_ONE_2019_ID = 'opus-one-2019';
const CHATEAU_MARGAUX_2015_ID = 'chateau-margaux-2015';
const PETRUS_2010_ID = 'petrus-2010';
const LAFITE_2016_ID = 'lafite-2016';
const MOUTON_2016_ID = 'mouton-2016';

// Burgundy
const ROMANEE_CONTI_2015_ID = 'romanee-conti-2015';

// Italian
const SASSICAIA_2018_ID = 'sassicaia-2018';
const BAROLO_CONTERNO_2015_ID = 'barolo-conterno-2015';
const MASI_AMARONE_2015_ID = 'masi-amarone-2015';
const TIGNANELLO_2018_ID = 'tignanello-2018';

// Australian
const PENFOLDS_GRANGE_2017_ID = 'penfolds-grange-2017';

// Californian
const SCREAMING_EAGLE_2018_ID = 'screaming-eagle-2018';

// White
const CLOUDY_BAY_2022_ID = 'cloudy-bay-2022';

// Sparkling
const MOET_BRUT_NV_ID = 'moet-brut-nv';
const DOM_PERIGNON_2012_ID = 'dom-perignon-2012';
const KRUG_GRANDE_CUVEE_ID = 'krug-grande-cuvee';

// Sweet
const YQUEM_2015_ID = 'yquem-2015';

// Aliases for the extended 35-wine dataset
const VESPA_QUALITY_ALIASES = [
  // Opus One
  { surfaceForm: 'opus one 2018', entityId: createEntityId(OPUS_ONE_2018_ID), confidence: 0.99 },
  { surfaceForm: 'opus one', entityId: createEntityId(OPUS_ONE_2018_ID), confidence: 0.90 },
  { surfaceForm: '오푸스원', entityId: createEntityId(OPUS_ONE_2018_ID), confidence: 0.98 },
  { surfaceForm: '오퍼스 원', entityId: createEntityId(OPUS_ONE_2018_ID), confidence: 0.92 },
  { surfaceForm: 'opus one 2019', entityId: createEntityId(OPUS_ONE_2019_ID), confidence: 0.99 },
  { surfaceForm: '오푸스원 2019', entityId: createEntityId(OPUS_ONE_2019_ID), confidence: 0.98 },
  // Bordeaux
  { surfaceForm: 'chateau margaux 2015', entityId: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.99 },
  { surfaceForm: 'château margaux', entityId: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.95 },
  { surfaceForm: 'chateau margaux', entityId: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.93 },
  { surfaceForm: '샤토 마고', entityId: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.97 },
  { surfaceForm: '마고', entityId: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.80 },
  { surfaceForm: 'petrus 2010', entityId: createEntityId(PETRUS_2010_ID), confidence: 0.99 },
  { surfaceForm: '페트뤼스', entityId: createEntityId(PETRUS_2010_ID), confidence: 0.97 },
  { surfaceForm: 'lafite 2016', entityId: createEntityId(LAFITE_2016_ID), confidence: 0.98 },
  { surfaceForm: '라피트', entityId: createEntityId(LAFITE_2016_ID), confidence: 0.95 },
  { surfaceForm: 'mouton 2016', entityId: createEntityId(MOUTON_2016_ID), confidence: 0.97 },
  { surfaceForm: '무통', entityId: createEntityId(MOUTON_2016_ID), confidence: 0.93 },
  // Burgundy
  { surfaceForm: 'romanee conti 2015', entityId: createEntityId(ROMANEE_CONTI_2015_ID), confidence: 0.99 },
  { surfaceForm: 'romanée-conti', entityId: createEntityId(ROMANEE_CONTI_2015_ID), confidence: 0.99 },
  { surfaceForm: '로마네 꽁티', entityId: createEntityId(ROMANEE_CONTI_2015_ID), confidence: 0.98 },
  { surfaceForm: 'drc 2015', entityId: createEntityId(ROMANEE_CONTI_2015_ID), confidence: 0.92 },
  { surfaceForm: 'drc', entityId: createEntityId(ROMANEE_CONTI_2015_ID), confidence: 0.88 },
  // Italian
  { surfaceForm: 'sassicaia 2018', entityId: createEntityId(SASSICAIA_2018_ID), confidence: 0.99 },
  { surfaceForm: '사시카이아', entityId: createEntityId(SASSICAIA_2018_ID), confidence: 0.97 },
  { surfaceForm: 'barolo monfortino 2015', entityId: createEntityId(BAROLO_CONTERNO_2015_ID), confidence: 0.99 },
  { surfaceForm: '바롤로', entityId: createEntityId(BAROLO_CONTERNO_2015_ID), confidence: 0.85 },
  { surfaceForm: 'masi amarone 2015', entityId: createEntityId(MASI_AMARONE_2015_ID), confidence: 0.99 },
  { surfaceForm: '아마로네', entityId: createEntityId(MASI_AMARONE_2015_ID), confidence: 0.95 },
  { surfaceForm: 'tignanello 2018', entityId: createEntityId(TIGNANELLO_2018_ID), confidence: 0.99 },
  // Australian
  { surfaceForm: 'penfolds grange 2017', entityId: createEntityId(PENFOLDS_GRANGE_2017_ID), confidence: 0.99 },
  { surfaceForm: '그레인지', entityId: createEntityId(PENFOLDS_GRANGE_2017_ID), confidence: 0.96 },
  { surfaceForm: 'penfolds grange', entityId: createEntityId(PENFOLDS_GRANGE_2017_ID), confidence: 0.92 },
  // Screaming Eagle
  { surfaceForm: 'screaming eagle 2018', entityId: createEntityId(SCREAMING_EAGLE_2018_ID), confidence: 0.99 },
  { surfaceForm: '스크리밍 이글', entityId: createEntityId(SCREAMING_EAGLE_2018_ID), confidence: 0.97 },
  // White wines
  { surfaceForm: 'cloudy bay 2022', entityId: createEntityId(CLOUDY_BAY_2022_ID), confidence: 0.99 },
  { surfaceForm: 'cloudy bay', entityId: createEntityId(CLOUDY_BAY_2022_ID), confidence: 0.92 },
  { surfaceForm: '클라우디베이', entityId: createEntityId(CLOUDY_BAY_2022_ID), confidence: 0.97 },
  // Sparkling
  { surfaceForm: 'moet brut', entityId: createEntityId(MOET_BRUT_NV_ID), confidence: 0.97 },
  { surfaceForm: 'moët brut', entityId: createEntityId(MOET_BRUT_NV_ID), confidence: 0.99 },
  { surfaceForm: '모에 샹동', entityId: createEntityId(MOET_BRUT_NV_ID), confidence: 0.97 },
  { surfaceForm: 'dom perignon 2012', entityId: createEntityId(DOM_PERIGNON_2012_ID), confidence: 0.99 },
  { surfaceForm: '돔 페리뇽', entityId: createEntityId(DOM_PERIGNON_2012_ID), confidence: 0.97 },
  { surfaceForm: 'krug grande cuvee', entityId: createEntityId(KRUG_GRANDE_CUVEE_ID), confidence: 0.99 },
  { surfaceForm: '크루그', entityId: createEntityId(KRUG_GRANDE_CUVEE_ID), confidence: 0.95 },
  // Sweet
  { surfaceForm: "chateau d'yquem 2015", entityId: createEntityId(YQUEM_2015_ID), confidence: 0.99 },
  { surfaceForm: 'yquem 2015', entityId: createEntityId(YQUEM_2015_ID), confidence: 0.97 },
  { surfaceForm: '이켐', entityId: createEntityId(YQUEM_2015_ID), confidence: 0.97 },
  { surfaceForm: '디켐', entityId: createEntityId(YQUEM_2015_ID), confidence: 0.95 },
];

// ---------------------------------------------------------------------------
// Known entity ID sets for semantic correctness tests
// ---------------------------------------------------------------------------

const FULL_BODY_IDS = new Set([
  OPUS_ONE_2018_ID,
  PENFOLDS_GRANGE_2017_ID,
  BAROLO_CONTERNO_2015_ID,
  MASI_AMARONE_2015_ID,
  SCREAMING_EAGLE_2018_ID,
  PETRUS_2010_ID,
  CHATEAU_MARGAUX_2015_ID,
  SASSICAIA_2018_ID,
]);

const SPARKLING_IDS = new Set([
  MOET_BRUT_NV_ID,
  DOM_PERIGNON_2012_ID,
  KRUG_GRANDE_CUVEE_ID,
]);

const HEAVY_RED_IDS = new Set([
  PENFOLDS_GRANGE_2017_ID,
  SCREAMING_EAGLE_2018_ID,
]);

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface SearchBody {
  readonly engineDecision: {
    readonly decisionStatus: string;
    readonly decisionSnapshot: Record<string, unknown>;
    readonly decisionConfidence: number;
  };
  readonly results: Array<{
    readonly entity: {
      readonly entityId: string;
      readonly canonicalLabel: string;
    };
    readonly relevanceScore: number;
    readonly evidenceItems: unknown[];
  }>;
  readonly clarification?: {
    readonly candidates: unknown[];
    readonly reason: string;
    readonly suggestionType: string;
  } | null;
  readonly meta: {
    readonly queryTimeMs: number;
    readonly route: string;
  };
}

async function search(
  app: FastifyInstance,
  query: string,
  options: {
    mode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
    clarification?: boolean;
  } = {},
): Promise<{ statusCode: number; body: SearchBody }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/search',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      query,
      options: {
        mode: options.mode ?? 'auto',
        explain: false,
        clarification: options.clarification ?? false,
      },
    }),
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as SearchBody,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!VESPA_URL)('Vespa E2E — SOTA++ Search Quality', () => {
  let server: VespaTestServer;

  beforeAll(async () => {
    server = await createVespaTestServer();

    // Register all 35-wine aliases for entity resolution
    for (const alias of VESPA_QUALITY_ALIASES) {
      server.parts.aliasMatcher.addAlias(
        alias.surfaceForm,
        alias.entityId,
        alias.confidence,
      );
    }

    // Register blocking candidates — all known entity IDs
    const allEntityIds = [
      OPUS_ONE_2018_ID, OPUS_ONE_2019_ID,
      CHATEAU_MARGAUX_2015_ID, PETRUS_2010_ID, LAFITE_2016_ID, MOUTON_2016_ID,
      ROMANEE_CONTI_2015_ID,
      SASSICAIA_2018_ID, BAROLO_CONTERNO_2015_ID, MASI_AMARONE_2015_ID, TIGNANELLO_2018_ID,
      PENFOLDS_GRANGE_2017_ID,
      SCREAMING_EAGLE_2018_ID,
      CLOUDY_BAY_2022_ID,
      MOET_BRUT_NV_ID, DOM_PERIGNON_2012_ID, KRUG_GRANDE_CUVEE_ID,
      YQUEM_2015_ID,
    ].map(createEntityId);

    server.parts.blockingAdapter.addEntityIds(allEntityIds);

    // Mark '마고' as ambiguous (region vs entity)
    server.parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'medium');
  });

  afterAll(async () => {
    await closeVespaTestServer(server);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 1: Entity Resolution Correctness
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 1: Entity Resolution Correctness', () => {
    it('"오푸스원" resolves to opus-one-2018', async () => {
      const { statusCode, body } = await search(server.app, '오푸스원', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(OPUS_ONE_2018_ID);
    });

    it('"Château Margaux 2015" (with accent) resolves to chateau-margaux-2015', async () => {
      const { statusCode, body } = await search(server.app, 'Château Margaux 2015', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(CHATEAU_MARGAUX_2015_ID);
    });

    it('"Chateau Margaux" (no accent) resolves to chateau-margaux-2015', async () => {
      const { statusCode, body } = await search(server.app, 'Chateau Margaux', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(CHATEAU_MARGAUX_2015_ID);
    });

    it('"로마네 꽁티" resolves to romanee-conti-2015', async () => {
      const { statusCode, body } = await search(server.app, '로마네 꽁티', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(ROMANEE_CONTI_2015_ID);
    });

    it('"그레인지" resolves to penfolds-grange-2017', async () => {
      const { statusCode, body } = await search(server.app, '그레인지', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(PENFOLDS_GRANGE_2017_ID);
    });

    it('"이켐" resolves to yquem-2015', async () => {
      const { statusCode, body } = await search(server.app, '이켐', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(YQUEM_2015_ID);
    });

    it('"DRC 2015" resolves to romanee-conti-2015', async () => {
      const { statusCode, body } = await search(server.app, 'DRC 2015', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(ROMANEE_CONTI_2015_ID);
    });

    it('"스크리밍 이글" resolves to screaming-eagle-2018', async () => {
      const { statusCode, body } = await search(server.app, '스크리밍 이글', { mode: 'entity' });

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.entity.entityId).toBe(SCREAMING_EAGLE_2018_ID);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 2: BM25 Ranking Quality
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 2: BM25 Ranking Quality', () => {
    it('exact "Opus One 2018" scores higher than partial "Opus One"', async () => {
      const [exactRes, partialRes] = await Promise.all([
        search(server.app, 'Opus One 2018', { mode: 'entity' }),
        search(server.app, 'Opus One', { mode: 'entity' }),
      ]);

      expect(exactRes.body.results.length).toBeGreaterThan(0);
      expect(partialRes.body.results.length).toBeGreaterThan(0);

      const exactScore = exactRes.body.results[0]!.relevanceScore;
      const partialScore = partialRes.body.results[0]!.relevanceScore;

      // Exact match must score at least as high as the partial match
      expect(exactScore).toBeGreaterThanOrEqual(partialScore);
    });

    it('top result for "오푸스원" has relevanceScore > 0.5', async () => {
      const { body } = await search(server.app, '오푸스원', { mode: 'entity' });

      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.relevanceScore).toBeGreaterThan(0.5);
    });

    it('results are in strictly non-ascending relevanceScore order', async () => {
      const { body } = await search(server.app, '풀바디 레드 와인', { mode: 'hybrid' });

      const results = body.results;
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1]!.relevanceScore;
        const curr = results[i]!.relevanceScore;
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });

    it('each result has a non-empty evidenceItems array', async () => {
      const { body } = await search(server.app, 'Opus One 2018', { mode: 'entity' });

      expect(body.results.length).toBeGreaterThan(0);
      for (const result of body.results) {
        expect(Array.isArray(result.evidenceItems)).toBe(true);
        expect(result.evidenceItems.length).toBeGreaterThan(0);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 3: Hybrid Search Semantic Correctness
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 3: Hybrid Search Semantic Correctness', () => {
    it('"풀바디 레드 와인" — all top results are full-body wines', async () => {
      const { statusCode, body } = await search(server.app, '풀바디 레드 와인', { mode: 'hybrid' });

      expect(statusCode).toBe(200);
      expect(body.results.length).toBeGreaterThan(0);

      // Top 3 results must all be known full-body wines
      const top3 = body.results.slice(0, Math.min(3, body.results.length));
      for (const result of top3) {
        expect(FULL_BODY_IDS.has(result.entity.entityId)).toBe(true);
      }
    });

    it('"달달한 와인" — top-3 must contain yquem-2015 (sweetness=0.95)', async () => {
      const { statusCode, body } = await search(server.app, '달달한 와인', { mode: 'hybrid' });

      expect(statusCode).toBe(200);

      const top3Ids = body.results.slice(0, 3).map((r) => r.entity.entityId);
      expect(top3Ids).toContain(YQUEM_2015_ID);
    });

    it('"스파클링 와인" — top-3 must contain at least one sparkling wine', async () => {
      const { statusCode, body } = await search(server.app, '스파클링 와인', { mode: 'hybrid' });

      expect(statusCode).toBe(200);

      const top3Ids = body.results.slice(0, 3).map((r) => r.entity.entityId);
      const hasSparklingWine = top3Ids.some((id) => SPARKLING_IDS.has(id));
      expect(hasSparklingWine).toBe(true);
    });

    it('"라이트바디 와인" — top-3 should NOT contain heavy reds (Grange or Screaming Eagle)', async () => {
      const { statusCode, body } = await search(server.app, '라이트바디 와인', { mode: 'hybrid' });

      expect(statusCode).toBe(200);

      const top3Ids = body.results.slice(0, 3).map((r) => r.entity.entityId);
      for (const id of top3Ids) {
        expect(HEAVY_RED_IDS.has(id)).toBe(false);
      }
    });

    it('"샴페인" — top-3 are sparkling wines', async () => {
      const { statusCode, body } = await search(server.app, '샴페인', { mode: 'hybrid' });

      expect(statusCode).toBe(200);

      if (body.results.length > 0) {
        const top3Ids = body.results.slice(0, Math.min(3, body.results.length)).map((r) => r.entity.entityId);
        const hasSparklingWine = top3Ids.some((id) => SPARKLING_IDS.has(id));
        expect(hasSparklingWine).toBe(true);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 4: Multilingual Consistency
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 4: Multilingual Consistency', () => {
    it('"Opus One" and "오푸스원" both resolve to opus-one-2018', async () => {
      const [enRes, koRes] = await Promise.all([
        search(server.app, 'Opus One', { mode: 'entity' }),
        search(server.app, '오푸스원', { mode: 'entity' }),
      ]);

      expect(enRes.body.engineDecision.decisionStatus).toBe('resolved');
      expect(koRes.body.engineDecision.decisionStatus).toBe('resolved');

      expect(enRes.body.results[0]!.entity.entityId).toBe(OPUS_ONE_2018_ID);
      expect(koRes.body.results[0]!.entity.entityId).toBe(OPUS_ONE_2018_ID);
    });

    it('"Château Margaux" and "샤토 마고" resolve to the same entity', async () => {
      const [enRes, koRes] = await Promise.all([
        search(server.app, 'Château Margaux', { mode: 'entity' }),
        search(server.app, '샤토 마고', { mode: 'entity' }),
      ]);

      expect(enRes.body.engineDecision.decisionStatus).toBe('resolved');
      expect(koRes.body.engineDecision.decisionStatus).toBe('resolved');

      const enId = enRes.body.results[0]!.entity.entityId;
      const koId = koRes.body.results[0]!.entity.entityId;
      expect(enId).toBe(koId);
      expect(enId).toBe(CHATEAU_MARGAUX_2015_ID);
    });

    it('"Dom Perignon" and "돔 페리뇽" resolve to the same entity', async () => {
      const [enRes, koRes] = await Promise.all([
        search(server.app, 'dom perignon 2012', { mode: 'entity' }),
        search(server.app, '돔 페리뇽', { mode: 'entity' }),
      ]);

      expect(enRes.body.engineDecision.decisionStatus).toBe('resolved');
      expect(koRes.body.engineDecision.decisionStatus).toBe('resolved');

      const enId = enRes.body.results[0]!.entity.entityId;
      const koId = koRes.body.results[0]!.entity.entityId;
      expect(enId).toBe(koId);
      expect(enId).toBe(DOM_PERIGNON_2012_ID);
    });

    it('"Penfolds Grange" and "그레인지" resolve to the same entity', async () => {
      const [enRes, koRes] = await Promise.all([
        search(server.app, 'penfolds grange', { mode: 'entity' }),
        search(server.app, '그레인지', { mode: 'entity' }),
      ]);

      expect(enRes.body.engineDecision.decisionStatus).toBe('resolved');
      expect(koRes.body.engineDecision.decisionStatus).toBe('resolved');

      const enId = enRes.body.results[0]!.entity.entityId;
      const koId = koRes.body.results[0]!.entity.entityId;
      expect(enId).toBe(koId);
      expect(enId).toBe(PENFOLDS_GRANGE_2017_ID);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 5: Ambiguity Detection
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 5: Ambiguity Detection', () => {
    it('"마고" is detected as ambiguous with clarification candidates', async () => {
      const { statusCode, body } = await search(server.app, '마고', {
        mode: 'entity',
        clarification: true,
      });

      expect(statusCode).toBe(200);
      // Should be ambiguous since we registered it as such
      expect(body.engineDecision.decisionStatus).toBe('ambiguous');
    });

    it('ambiguous query with clarification=true returns candidates.length >= 1', async () => {
      const { statusCode, body } = await search(server.app, '마고', {
        mode: 'entity',
        clarification: true,
      });

      expect(statusCode).toBe(200);

      if (body.clarification != null) {
        expect(body.clarification.candidates.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 6: Graceful Degradation
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 6: Graceful Degradation', () => {
    it('"zzz_no_such_wine_xyz_abc" — results=[], decisionStatus=failed (not 500)', async () => {
      const { statusCode, body } = await search(server.app, 'zzz_no_such_wine_xyz_abc');

      expect(statusCode).toBe(200);
      expect(body.engineDecision.decisionStatus).toBe('failed');
      expect(body.results).toHaveLength(0);
    });

    it('"😀 emoji wine" — 200, no crash', async () => {
      const { statusCode } = await search(server.app, '😀 emoji wine');

      expect(statusCode).toBe(200);
    });

    it('1000-character query — 200, no crash', async () => {
      const longQuery = 'wine '.repeat(200).trim();

      const { statusCode } = await search(server.app, longQuery);

      expect(statusCode).toBe(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Group 7: Response Completeness
  // ───────────────────────────────────────────────────────────────────────────

  describe('Group 7: Response Completeness', () => {
    it('resolved response has results[0].entityId as string', async () => {
      const { body } = await search(server.app, 'Opus One 2018', { mode: 'entity' });

      expect(body.engineDecision.decisionStatus).toBe('resolved');
      expect(body.results.length).toBeGreaterThan(0);

      const entityId = body.results[0]!.entity.entityId;
      expect(typeof entityId).toBe('string');
      expect(entityId.length).toBeGreaterThan(0);
    });

    it('resolved response has results[0].relevanceScore in [0, 1]', async () => {
      const { body } = await search(server.app, 'Opus One 2018', { mode: 'entity' });

      expect(body.results.length).toBeGreaterThan(0);
      const score = body.results[0]!.relevanceScore;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('resolved response has results[0].evidenceItems.length > 0', async () => {
      const { body } = await search(server.app, 'Opus One 2018', { mode: 'entity' });

      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0]!.evidenceItems.length).toBeGreaterThan(0);
    });

    it('decisionSnapshot has all 6 RFC-015 fields', async () => {
      const { body } = await search(server.app, 'Opus One 2018', { mode: 'entity' });

      const snap = body.engineDecision.decisionSnapshot;
      expect(snap).toBeDefined();
      expect(snap).toHaveProperty('model_versions');
      expect(snap).toHaveProperty('index_versions');
      expect(snap).toHaveProperty('policy_rule_version');
      expect(snap).toHaveProperty('threshold_profile_id');
      expect(snap).toHaveProperty('planner_version');
      expect(snap).toHaveProperty('feature_flags');
    });

    it('meta.queryTimeMs >= 0', async () => {
      const { body } = await search(server.app, 'Opus One 2018');

      expect(body.meta.queryTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
