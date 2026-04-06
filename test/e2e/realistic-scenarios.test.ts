/**
 * Realistic in-memory scenario tests.
 *
 * This suite is intentionally smoke-oriented: it covers alias normalization,
 * bilingual retrieval, mode routing, and graceful degradation without
 * overfitting to in-memory semantic ranking. Deeper quality expectations live
 * in golden-set and Vespa-backed suites.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchDecisionStatus,
  getSearchEntityIds,
  getSearchMeta,
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

async function search(body: unknown) {
  const response = await postJson(server.app, '/v1/search', body);
  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

describe('Realistic Scenarios — alias normalization', () => {
  const cases = [
    ['오퍼스 원', 'opus-one-2018'],
    ['opusone', 'opus-one-2018'],
    ['romanee conti', 'romanee-conti-2019'],
    ['grange', 'penfolds-grange-2017'],
  ] as const;

  for (const [query, expectedEntityId] of cases) {
    it(`'${query}' stays non-failed in entity mode and keeps '${expectedEntityId}' in the hybrid top-5`, async () => {
      const entity = await search({
        query,
        options: { mode: 'entity', explain: false, clarification: false },
      });
      const hybrid = await search({
        query,
        options: { mode: 'hybrid', explain: false, clarification: false },
      });

      expect(getSearchDecisionStatus(entity)).not.toBe('failed');
      expect(getSearchEntityIds(hybrid).slice(0, 5)).toContain(expectedEntityId);
    });
  }

  it('accented and accent-stripped Margaux queries do not fail', async () => {
    const accented = await search({
      query: 'Château Margaux',
      options: { mode: 'entity', explain: false, clarification: false },
    });
    const stripped = await search({
      query: 'Chateau Margaux',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(accented)).not.toBe('failed');
    expect(getSearchEntityIds(stripped).slice(0, 5)).toContain('chateau-margaux-2015');
  });
});

describe('Realistic Scenarios — vintage and specificity', () => {
  it("'Opus One' without a vintage resolves or abstains safely", async () => {
    const body = await search({
      query: 'Opus One',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'Sassicaia 2018' stays retrievable in hybrid top-5", async () => {
    const body = await search({
      query: 'Sassicaia 2018',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(getSearchEntityIds(body).slice(0, 5)).toContain('sassicaia-2018');
  });

  it("'Opus One 2099' remains graceful for unknown vintages", async () => {
    const body = await search({
      query: 'Opus One 2099',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toMatch(/^(resolved|ambiguous|failed)$/);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("'2018 Cabernet' returns at least one Cabernet-led wine in the top-5", async () => {
    const cabernetIds = new Set(['opus-one-2018', 'chateau-margaux-2015', 'sassicaia-2018']);
    const body = await search({
      query: '2018 Cabernet',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    const topFive = getSearchEntityIds(body).slice(0, 5);
    expect(topFive.some((entityId) => cabernetIds.has(entityId))).toBe(true);
  });
});

describe('Realistic Scenarios — semantic and multilingual smoke', () => {
  it("'결혼식 샴페인' keeps a sparkling candidate in the top-5", async () => {
    const body = await search({
      query: '결혼식 샴페인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(getSearchEntityIds(body).slice(0, 5)).toContain('moet-brut');
  });

  it("'스테이크랑 어울리는 와인' keeps at least one steak-friendly red in the top-5", async () => {
    const steakIds = new Set(['opus-one-2018', 'penfolds-grange-2017', 'sassicaia-2018']);
    const body = await search({
      query: '스테이크랑 어울리는 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    const topFive = getSearchEntityIds(body).slice(0, 5);
    expect(topFive.some((entityId) => steakIds.has(entityId))).toBe(true);
  });

  it("'Bordeaux 레드 와인' keeps a Bordeaux candidate in the top-5", async () => {
    const bordeauxIds = new Set(['chateau-margaux-2015', 'sauternes-2015']);
    const body = await search({
      query: 'Bordeaux 레드 와인',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    const topFive = getSearchEntityIds(body).slice(0, 5);
    expect(topFive.some((entityId) => bordeauxIds.has(entityId))).toBe(true);
  });

  it("'피노누아' keeps Burgundy Pinot in the top-5", async () => {
    const body = await search({
      query: '피노누아',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(getSearchEntityIds(body).slice(0, 5)).toContain('romanee-conti-2019');
  });

  it("'아마로네 강한' returns non-empty results in auto mode", async () => {
    const body = await search({
      query: '아마로네 강한',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(body.results.length).toBeGreaterThan(0);
  });
});

describe('Realistic Scenarios — graceful degradation', () => {
  it("'Petrus 2000' stays ambiguous or failed instead of crashing", async () => {
    const body = await search({
      query: 'Petrus 2000',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toMatch(/^(ambiguous|failed)$/);
  });

  it("'Screaming Eagle' returns a well-formed 200 response", async () => {
    const body = await search({
      query: 'Screaming Eagle',
      options: { mode: 'entity', explain: false, clarification: false },
    });

    expect(Array.isArray(body.results)).toBe(true);
  });

  it("'wine under 10000 won' stays graceful even without fixture support", async () => {
    const body = await search({
      query: 'wine under 10000 won',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe('Realistic Scenarios — mode routing', () => {
  it("auto mode routes '오푸스원' through a supported fast-path", async () => {
    const body = await search({
      query: '오푸스원',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(getSearchMeta(body).route).toMatch(/^(entity|hybrid|mixed)$/);
  });

  it("auto mode routes '풀바디 레드 추천' to a retrieval path", async () => {
    const body = await search({
      query: '풀바디 레드 추천',
      options: { mode: 'auto', explain: false, clarification: false },
    });

    expect(getSearchMeta(body).route).toMatch(/^(hybrid|mixed)$/);
  });

  it("forcing hybrid mode on '오푸스원' keeps the seed entity in the top-5", async () => {
    const body = await search({
      query: '오푸스원',
      options: { mode: 'hybrid', explain: false, clarification: false },
    });

    expect(body.results.length).toBeGreaterThan(0);
    expect(getSearchEntityIds(body).slice(0, 5)).toContain('opus-one-2018');
  });
});
