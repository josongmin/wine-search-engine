/**
 * Golden-set quality tests for the in-memory search harness.
 *
 * These checks intentionally validate retrieval quality, not raw HTTP contract.
 * Assertions are relaxed to top-k containment and score ordering so that the
 * suite catches meaningful regressions without overfitting to fixture order.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchEntityIds,
  getSearchRelevanceScores,
  parseSearchResponse,
  postJson,
} from './helpers/http-transport.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

async function searchHybrid(query: string) {
  const response = await postJson(server.app, '/v1/search', {
    query,
    options: { mode: 'hybrid', explain: false, clarification: false },
  });

  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

describe('Golden Set — exact entity retrieval', () => {
  const cases = [
    ['Opus One 2018', 'opus-one-2018'],
    ['Sassicaia 2018', 'sassicaia-2018'],
    ['Penfolds Grange 2017', 'penfolds-grange-2017'],
    ['Masi Amarone', 'masi-amarone'],
    ['오푸스원', 'opus-one-2018'],
    ['이켐', 'sauternes-2015'],
    ['모에 샹동', 'moet-brut'],
    ['Barolo Monfortino', 'barolo-giacomo'],
  ] as const;

  for (const [query, expectedEntityId] of cases) {
    it(`'${query}' keeps '${expectedEntityId}' in the hybrid top-3`, async () => {
      const body = await searchHybrid(query);
      expect(body.results.length).toBeGreaterThan(0);
      expect(getSearchEntityIds(body).slice(0, 3)).toContain(expectedEntityId);
    });
  }
});

describe('Golden Set — semantic quality', () => {
  it("'스파클링 와인' keeps moet-brut in the top-3", async () => {
    const body = await searchHybrid('스파클링 와인');
    expect(getSearchEntityIds(body).slice(0, 3)).toContain('moet-brut');
  });

  it("'달달한 와인' keeps sauternes-2015 in the top-3", async () => {
    const body = await searchHybrid('달달한 와인');
    expect(getSearchEntityIds(body).slice(0, 3)).toContain('sauternes-2015');
  });

  it("'Cloudy Bay' keeps cloudy-bay-2022 in the top-5", async () => {
    const body = await searchHybrid('Cloudy Bay');
    expect(getSearchEntityIds(body).slice(0, 5)).toContain('cloudy-bay-2022');
  });

  it("'Moet Brut' keeps moet-brut in the top-5", async () => {
    const body = await searchHybrid('Moet Brut');
    expect(getSearchEntityIds(body).slice(0, 5)).toContain('moet-brut');
  });
});

describe('Golden Set — ranking invariants', () => {
  const orderedQueries = ['Opus One 2018', '풀바디 레드 와인', '스파클링 와인'] as const;

  for (const query of orderedQueries) {
    it(`'${query}' remains non-increasing by relevance_score`, async () => {
      const body = await searchHybrid(query);
      const scores = getSearchRelevanceScores(body);

      for (let index = 1; index < scores.length; index += 1) {
        expect(scores[index - 1]).toBeGreaterThanOrEqual(scores[index]!);
      }
    });
  }

  it("'풀바디 레드 와인' keeps at least 3 full-body wines in the top-5", async () => {
    const fullBodyIds = new Set([
      'opus-one-2018',
      'chateau-margaux-2015',
      'sassicaia-2018',
      'penfolds-grange-2017',
      'barolo-giacomo',
      'masi-amarone',
    ]);

    const body = await searchHybrid('풀바디 레드 와인');
    const topFive = getSearchEntityIds(body).slice(0, 5);
    const fullBodyCount = topFive.filter((entityId) => fullBodyIds.has(entityId)).length;

    expect(fullBodyCount).toBeGreaterThanOrEqual(3);
  });
});
