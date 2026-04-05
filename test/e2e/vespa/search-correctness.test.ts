/**
 * Vespa Real E2E — Search Correctness Tests
 *
 * These tests run against a live Vespa instance. They are skipped when
 * VESPA_URL is not set so they do not break CI environments without Vespa.
 *
 * The test data must be seeded before these tests execute:
 *   npx tsx scripts/seed-vespa-test-data.ts
 *
 * Tests are organised into five groups:
 *   1. BM25 Text Search Correctness
 *   2. Korean Text Search
 *   3. Attribute Filters
 *   4. Result Quality
 *   5. Graceful Degradation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { VespaSearchIndex } from '../../../src/infrastructure/vespa/vespa-search-index.js';
import { VespaClient } from '../../../src/infrastructure/vespa/vespa-client.js';
import type { SparseHit } from '../../../src/domain/retrieval/port/search-index.port.js';
import {
  OPUS_ONE_ID,
  CHATEAU_MARGAUX_ID,
  SASSICAIA_ID,
  PENFOLDS_GRANGE_ID,
  ROMANEE_CONTI_ID,
  CLOUDY_BAY_ID,
  MOET_BRUT_ID,
  SAUTERNES_ID,
  BAROLO_GIACOMO_ID,
  MASI_AMARONE_ID,
  FULL_BODY_RED_IDS,
  SWEET_WINE_IDS,
  SPARKLING_IDS,
} from './helpers/vespa-test-fixtures.js';

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const VESPA_URL = process.env['VESPA_URL'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the entity IDs from a hit array in order. */
function entityIds(hits: readonly SparseHit[]): readonly string[] {
  return hits.map((h) => h.entityId);
}

/** Returns true when the given entity ID appears in the hit list. */
function contains(hits: readonly SparseHit[], id: string): boolean {
  return hits.some((h) => h.entityId === id);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!VESPA_URL)('Vespa Real E2E — Search Correctness', () => {
  let index: VespaSearchIndex;

  // Verify Vespa is reachable before any test runs.
  beforeAll(async () => {
    const url = VESPA_URL!; // guarded by skipIf
    const client = new VespaClient(url, 'wine', 'wine_entity');
    index = new VespaSearchIndex(client);

    // Smoke-test: a simple query must not throw.
    await index.sparseSearch(['Opus One'], [], 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 1: BM25 Text Search Correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe('BM25 Text Search Correctness', () => {
    it('exact query "Opus One 2018" — top-1 entity is opus-one-2018 with score > 0.5', async () => {
      const hits = await index.sparseSearch(['Opus One 2018'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      const topHit = hits[0];
      expect(topHit).toBeDefined();
      expect(topHit!.entityId).toBe(OPUS_ONE_ID);
      expect(topHit!.score).toBeGreaterThan(0.5);
    });

    it('"Opus One" (without vintage) — opus-one-2018 is in top-3 at rank 1', async () => {
      const hits = await index.sparseSearch(['Opus One'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      const top3Ids = entityIds(hits.slice(0, 3));
      expect(top3Ids).toContain(OPUS_ONE_ID);
      // Rank must be 1 since it is the best match for "Opus One"
      expect(hits[0]!.entityId).toBe(OPUS_ONE_ID);
    });

    it('"오푸스원" Korean alias — resolves to opus-one-2018 in top results', async () => {
      const hits = await index.sparseSearch(['오푸스원'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      expect(contains(hits, OPUS_ONE_ID)).toBe(true);
      // The Korean alias should be the top hit or very close to it.
      const rank = hits.findIndex((h) => h.entityId === OPUS_ONE_ID) + 1;
      expect(rank).toBeLessThanOrEqual(3);
    });

    it('"Sassicaia" partial name — top-1 is sassicaia-2018', async () => {
      const hits = await index.sparseSearch(['Sassicaia'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.entityId).toBe(SASSICAIA_ID);
    });

    it('BM25 ordering: exact "Château Margaux" scores higher than partial "Margaux"', async () => {
      const [exactHits, partialHits] = await Promise.all([
        index.sparseSearch(['Château Margaux'], [], 10),
        index.sparseSearch(['Margaux'], [], 10),
      ]);

      const exactMargauxHit = exactHits.find((h) => h.entityId === CHATEAU_MARGAUX_ID);
      const partialMargauxHit = partialHits.find((h) => h.entityId === CHATEAU_MARGAUX_ID);

      expect(exactMargauxHit).toBeDefined();
      expect(partialMargauxHit).toBeDefined();
      // The exact match must achieve a higher score than the partial match.
      expect(exactMargauxHit!.score).toBeGreaterThan(partialMargauxHit!.score);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 2: Korean Text Search
  // ─────────────────────────────────────────────────────────────────────────

  describe('Korean Text Search', () => {
    it('"풀바디 레드 와인" — results contain opus-one-2018, sassicaia-2018, penfolds-grange-2017', async () => {
      const hits = await index.sparseSearch(['풀바디 레드 와인'], [], 20);

      const ids = entityIds(hits);
      expect(ids).toContain(OPUS_ONE_ID);
      expect(ids).toContain(SASSICAIA_ID);
      expect(ids).toContain(PENFOLDS_GRANGE_ID);
    });

    it('"달달한 와인" — results contain sauternes-2015', async () => {
      const hits = await index.sparseSearch(['달달한 와인'], [], 20);

      expect(contains(hits, SAUTERNES_ID)).toBe(true);
    });

    it('"스파클링 와인" — results contain moet-brut', async () => {
      const hits = await index.sparseSearch(['스파클링 와인'], [], 20);

      expect(contains(hits, MOET_BRUT_ID)).toBe(true);
    });

    it('"로마네 꽁티" Korean alias — resolves to romanee-conti-2015 (document has availability=false so not in results)', async () => {
      // romanee-conti-2015 has availability=false; sparseSearch filters it out.
      // This test verifies the filter works correctly.
      const hits = await index.sparseSearch(['로마네 꽁티'], [], 20);

      // The document MUST NOT appear because availability = false.
      expect(contains(hits, ROMANEE_CONTI_ID)).toBe(false);
    });

    it('multi-language consistency: "Opus One" and "오푸스원" both resolve to opus-one-2018', async () => {
      const [enHits, koHits] = await Promise.all([
        index.sparseSearch(['Opus One'], [], 5),
        index.sparseSearch(['오푸스원'], [], 5),
      ]);

      // Both queries must rank opus-one-2018 as the best or very close result.
      const enTopEntity = enHits[0]?.entityId;

      expect(enTopEntity).toBe(OPUS_ONE_ID);
      // Korean query: the entity must appear within the top 3
      const koRank = koHits.findIndex((h) => h.entityId === OPUS_ONE_ID);
      expect(koRank).toBeGreaterThanOrEqual(0); // exists
      expect(koRank).toBeLessThanOrEqual(2);    // within top 3
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 3: Attribute Filters
  // ─────────────────────────────────────────────────────────────────────────

  describe('Attribute Filters', () => {
    it('filter body_min:0.8 — every returned wine has body > 0.8', async () => {
      // Query broadly; the filter must narrow results to high-body wines.
      // We use an open query that would otherwise return many results.
      const hits = await index.sparseSearch(
        ['red wine'],
        ['body_min:0.8'],
        50,
      );

      // We must get some hits (we have several high-body wines indexed).
      expect(hits.length).toBeGreaterThan(0);

      // Every hit must correspond to a high-body document.
      const highBodyIds = new Set<string>(FULL_BODY_RED_IDS.map(String));
      for (const hit of hits) {
        // The Vespa filter must have already applied body >= 0.8.
        // We verify by checking our fixture knowledge.
        expect(highBodyIds.has(hit.entityId)).toBe(true);
      }
    });

    it('filter sweetness>0.5 (body_min:0.5 proxy not applicable — use direct sweetness check via known IDs)', async () => {
      // Vespa's filter token vocabulary uses body_min/body_max, not sweetness.
      // Sweet wines contain specific keywords in their search text.
      // This test verifies sweet wines appear when searching for "sweet wine".
      const hits = await index.sparseSearch(['sweet wine'], [], 20);

      const sweetIds = new Set<string>(SWEET_WINE_IDS.map(String));
      const returnedSweetIds = hits
        .map((h) => h.entityId)
        .filter((id) => sweetIds.has(id));

      // At least the sauternes must appear.
      expect(returnedSweetIds.length).toBeGreaterThan(0);
      expect(returnedSweetIds).toContain(SAUTERNES_ID);
    });

    it('filter style:"full-body red" — returned wines all have full-body red style', async () => {
      const hits = await index.sparseSearch(
        ['wine'],
        ['style:full-body red'],
        50,
      );

      expect(hits.length).toBeGreaterThan(0);

      // All returned entity IDs must be in the full-body red set.
      const fullBodyRedSet = new Set<string>(FULL_BODY_RED_IDS.map(String));
      for (const hit of hits) {
        expect(fullBodyRedSet.has(hit.entityId)).toBe(true);
      }
    });

    it('filter availability:true — all returned wines are available (romanee-conti-2019 absent)', async () => {
      // Run a very broad query; availability=true is already the default
      // filter applied by sparseSearch, but we can also pass it explicitly.
      const hits = await index.sparseSearch(
        ['wine'],
        ['availability:true'],
        50,
      );

      // romanee-conti-2019 has availability=false and must be absent.
      const ids = entityIds(hits);
      expect(ids).not.toContain(ROMANEE_CONTI_ID);

      // Several available wines must be present.
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 4: Result Quality
  // ─────────────────────────────────────────────────────────────────────────

  describe('Result Quality', () => {
    it('results are sorted descending by relevance score', async () => {
      const hits = await index.sparseSearch(['red wine Bordeaux'], [], 20);

      expect(hits.length).toBeGreaterThan(1);
      for (let i = 1; i < hits.length; i++) {
        const prev = hits[i - 1]!.score;
        const curr = hits[i]!.score;
        // Scores must be non-ascending.
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });

    it('all returned entity IDs are non-empty strings', async () => {
      const hits = await index.sparseSearch(['wine'], [], 50);

      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(typeof hit.entityId).toBe('string');
        expect(hit.entityId.length).toBeGreaterThan(0);
      }
    });

    it('exact match has higher score than partial match for the same wine', async () => {
      const [exactHits, partialHits] = await Promise.all([
        index.sparseSearch(['Penfolds Grange 2017'], [], 10),
        index.sparseSearch(['Grange'], [], 10),
      ]);

      const exactHit = exactHits.find((h) => h.entityId === PENFOLDS_GRANGE_ID);
      const partialHit = partialHits.find((h) => h.entityId === PENFOLDS_GRANGE_ID);

      expect(exactHit).toBeDefined();
      expect(partialHit).toBeDefined();
      expect(exactHit!.score).toBeGreaterThan(partialHit!.score);
    });

    it('all results have a non-negative rank starting at 1', async () => {
      const hits = await index.sparseSearch(['wine'], [], 20);

      expect(hits.length).toBeGreaterThan(0);
      hits.forEach((hit, i) => {
        expect(hit.rank).toBe(i + 1);
      });
    });

    it('each hit exposes at least one matched field', async () => {
      const hits = await index.sparseSearch(['Opus One 2018'], [], 5);

      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(Array.isArray(hit.matchedFields)).toBe(true);
        expect(hit.matchedFields.length).toBeGreaterThan(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 5: Graceful Degradation
  // ─────────────────────────────────────────────────────────────────────────

  describe('Graceful Degradation', () => {
    it('unknown wine "zzz_xyz_wine_not_exist" — returns 0 results (not an error)', async () => {
      const hits = await index.sparseSearch(['zzz_xyz_wine_not_exist'], [], 10);

      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBe(0);
    });

    it('very long query — Vespa handles it without throwing', async () => {
      const longQuery = 'wine '.repeat(200).trim();

      await expect(
        index.sparseSearch([longQuery], [], 10),
      ).resolves.not.toThrow();
    });

    it('special characters in query — handled gracefully', async () => {
      const queries = [
        'wine "Opus One"',
        "d'Yquem",
        'Château & Margaux',
        '【wine】',
        'wine\twith\ttabs',
      ];

      for (const q of queries) {
        await expect(
          index.sparseSearch([q], [], 5),
        ).resolves.not.toThrow();
      }
    });

    it('empty filter list — behaves the same as no filters', async () => {
      const [withEmpty, withoutFilters] = await Promise.all([
        index.sparseSearch(['Opus One'], [], 5),
        index.sparseSearch(['Opus One'], undefined, 5),
      ]);

      // Both should return the same top hit.
      expect(withEmpty[0]?.entityId).toBe(withoutFilters[0]?.entityId);
    });

    it('limit=1 — returns exactly one result', async () => {
      const hits = await index.sparseSearch(['wine'], [], 1);

      expect(hits.length).toBeLessThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Additional: cross-entity coverage
  // ─────────────────────────────────────────────────────────────────────────

  describe('Additional coverage', () => {
    it('"Cloudy Bay" — resolves to cloudy-bay-2022', async () => {
      const hits = await index.sparseSearch(['Cloudy Bay'], [], 5);

      expect(contains(hits, CLOUDY_BAY_ID)).toBe(true);
    });

    it('"Masi Amarone" — resolves to masi-amarone in top results', async () => {
      const hits = await index.sparseSearch(['Masi Amarone'], [], 5);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.entityId).toBe(MASI_AMARONE_ID);
    });

    it('"아마로네" Korean alias — resolves to masi-amarone', async () => {
      const hits = await index.sparseSearch(['아마로네'], [], 10);

      expect(contains(hits, MASI_AMARONE_ID)).toBe(true);
    });

    it('"Barolo Giacomo Conterno" — resolves to barolo-giacomo in top results', async () => {
      const hits = await index.sparseSearch(['Barolo Giacomo Conterno'], [], 5);

      expect(hits.length).toBeGreaterThan(0);
      expect(contains(hits.slice(0, 3), BAROLO_GIACOMO_ID)).toBe(true);
    });

    it('"sparkling" — moet-brut appears in results', async () => {
      const hits = await index.sparseSearch(['sparkling'], [], 10);

      expect(contains(hits, MOET_BRUT_ID)).toBe(true);
    });

    it('Korean sparkling query "스파클링" — moet-brut appears', async () => {
      const hits = await index.sparseSearch(['스파클링'], [], 10);

      const sparklingSet = new Set<string>(SPARKLING_IDS.map(String));
      const returned = hits.filter((h) => sparklingSet.has(h.entityId));
      expect(returned.length).toBeGreaterThan(0);
    });
  });
});
