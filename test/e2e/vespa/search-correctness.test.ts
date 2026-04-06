import { beforeAll, describe, expect, it } from 'vitest';
import { VespaSearchIndex } from '../../../src/infrastructure/vespa/vespa-search-index.js';
import { VespaClient } from '../../../src/infrastructure/vespa/vespa-client.js';
import type { SparseHit } from '../../../src/domain/retrieval/port/search-index.port.js';
import {
  BAROLO_GIACOMO_ID,
  CHATEAU_MARGAUX_ID,
  CLOUDY_BAY_ID,
  MASI_AMARONE_ID,
  OPUS_ONE_ID,
  PENFOLDS_GRANGE_ID,
  ROMANEE_CONTI_ID,
  SASSICAIA_ID,
  SAUTERNES_ID,
} from './helpers/vespa-test-fixtures.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';

const VESPA_URL = process.env['VESPA_URL'];

function entityIds(hits: readonly SparseHit[]): readonly string[] {
  return hits.map((hit) => hit.entityId);
}

function contains(hits: readonly SparseHit[], entityId: string): boolean {
  return hits.some((hit) => hit.entityId === entityId);
}

describe.skipIf(!HAS_REACHABLE_VESPA)('Vespa Real E2E — Search Correctness', () => {
  let index: VespaSearchIndex;

  beforeAll(async () => {
    const client = new VespaClient(VESPA_URL!, 'wine', 'wine_entity');
    index = new VespaSearchIndex(client);
    await index.sparseSearch(['Opus One'], [], 1);
  });

  describe('Exact And Partial Lookup', () => {
    it('exact query "Opus One 2018" returns opus-one-2018 as top-1', async () => {
      const hits = await index.sparseSearch(['Opus One 2018'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.entityId).toBe(OPUS_ONE_ID);
      expect(hits[0]!.score).toBeGreaterThan(0.5);
    });

    it('"Opus One" keeps opus-one-2018 in the top 3', async () => {
      const hits = await index.sparseSearch(['Opus One'], [], 10);

      expect(entityIds(hits.slice(0, 3))).toContain(OPUS_ONE_ID);
      expect(hits[0]!.entityId).toBe(OPUS_ONE_ID);
    });

    it('"Sassicaia" returns sassicaia-2018 as top-1', async () => {
      const hits = await index.sparseSearch(['Sassicaia'], [], 10);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.entityId).toBe(SASSICAIA_ID);
    });

    it('exact "Château Margaux" scores higher than partial "Margaux"', async () => {
      const [exactHits, partialHits] = await Promise.all([
        index.sparseSearch(['Château Margaux'], [], 10),
        index.sparseSearch(['Margaux'], [], 10),
      ]);

      const exactMargauxHit = exactHits.find((hit) => hit.entityId === CHATEAU_MARGAUX_ID);
      const partialMargauxHit = partialHits.find((hit) => hit.entityId === CHATEAU_MARGAUX_ID);

      expect(exactMargauxHit).toBeDefined();
      expect(partialMargauxHit).toBeDefined();
      expect(exactMargauxHit!.score).toBeGreaterThan(partialMargauxHit!.score);
    });
  });

  describe('Fixture-Backed Retrieval', () => {
    it('"달달한 와인" returns a sweet wine result set that includes yquem-2015', async () => {
      const hits = await index.sparseSearch(['달달한 와인'], [], 20);
      expect(contains(hits, SAUTERNES_ID)).toBe(true);
    });

    it('"로마네 꽁티" does not return romanee-conti-2015 because availability=false', async () => {
      const hits = await index.sparseSearch(['로마네 꽁티'], [], 20);
      expect(contains(hits, ROMANEE_CONTI_ID)).toBe(false);
    });

    it('"Cloudy Bay" returns cloudy-bay-2022', async () => {
      const hits = await index.sparseSearch(['Cloudy Bay'], [], 5);
      expect(contains(hits, CLOUDY_BAY_ID)).toBe(true);
    });

    it('"Masi Amarone" returns masi-amarone-2015 as top-1', async () => {
      const hits = await index.sparseSearch(['Masi Amarone'], [], 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.entityId).toBe(MASI_AMARONE_ID);
    });

    it('"아마로네" includes masi-amarone-2015 in the result set', async () => {
      const hits = await index.sparseSearch(['아마로네'], [], 10);
      expect(contains(hits, MASI_AMARONE_ID)).toBe(true);
    });

    it('"Barolo Giacomo Conterno" keeps the expected entity in the top 3', async () => {
      const hits = await index.sparseSearch(['Barolo Giacomo Conterno'], [], 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(contains(hits.slice(0, 3), BAROLO_GIACOMO_ID)).toBe(true);
    });
  });

  describe('Filters And Ordering', () => {
    it('availability:true excludes unavailable fixture documents', async () => {
      const hits = await index.sparseSearch(['wine'], ['availability:true'], 50);

      expect(hits.length).toBeGreaterThan(0);
      expect(entityIds(hits)).not.toContain(ROMANEE_CONTI_ID);
    });

    it('results are sorted by non-ascending score', async () => {
      const hits = await index.sparseSearch(['red wine Bordeaux'], [], 20);

      expect(hits.length).toBeGreaterThan(1);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
      }
    });

    it('exact Penfolds query scores higher than partial "Grange"', async () => {
      const [exactHits, partialHits] = await Promise.all([
        index.sparseSearch(['Penfolds Grange 2017'], [], 10),
        index.sparseSearch(['Grange'], [], 10),
      ]);

      const exactHit = exactHits.find((hit) => hit.entityId === PENFOLDS_GRANGE_ID);
      const partialHit = partialHits.find((hit) => hit.entityId === PENFOLDS_GRANGE_ID);

      expect(exactHit).toBeDefined();
      expect(partialHit).toBeDefined();
      expect(exactHit!.score).toBeGreaterThan(partialHit!.score);
    });

    it('matched fields are exposed for exact hits', async () => {
      const hits = await index.sparseSearch(['Opus One 2018'], [], 5);

      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(Array.isArray(hit.matchedFields)).toBe(true);
        expect(hit.matchedFields.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Graceful Degradation', () => {
    it('unknown wine returns an empty array', async () => {
      const hits = await index.sparseSearch(['zzz_xyz_wine_not_exist'], [], 10);
      expect(hits).toHaveLength(0);
    });

    it('very long query does not throw', async () => {
      const longQuery = 'wine '.repeat(200).trim();
      await expect(index.sparseSearch([longQuery], [], 10)).resolves.not.toThrow();
    });

    it('special-character queries do not throw', async () => {
      const queries = [
        'wine "Opus One"',
        "d'Yquem",
        'Château & Margaux',
        '【wine】',
        'wine\twith\ttabs',
      ];

      for (const query of queries) {
        await expect(index.sparseSearch([query], [], 5)).resolves.not.toThrow();
      }
    });

    it('limit=1 returns at most one result', async () => {
      const hits = await index.sparseSearch(['wine'], [], 1);
      expect(hits.length).toBeLessThanOrEqual(1);
    });
  });
});
