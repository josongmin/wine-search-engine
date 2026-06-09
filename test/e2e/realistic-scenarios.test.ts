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
  parseEntityLookupResponse,
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
  const response = await postJson(server.app, '/v1/search/hybrid', body);
  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

async function lookup(query: string) {
  const response = await postJson(server.app, '/v2/entity-lookup', { query });
  expect(response.statusCode).toBe(200);
  return parseEntityLookupResponse(response);
}

describe('Realistic Scenarios — alias normalization', () => {
  const identitySafeCases = [
    ['오퍼스 원', 'opus-one-2018'],
    ['opusone', 'opus-one-2018'],
    ['romanee conti', 'romanee-conti-2019'],
  ] as const;

  for (const [query, expectedEntityId] of identitySafeCases) {
    it(`'${query}' stays non-failed in lookup and keeps '${expectedEntityId}' in the hybrid top-5`, async () => {
      const entity = await lookup(query);
      const hybrid = await search({
        query,
        options: { explain: false, clarification: false },
      });

      expect(entity.status).toMatch(/^(resolved|ambiguous)$/);
      expect(getSearchEntityIds(hybrid).slice(0, 5)).toContain(expectedEntityId);
    });
  }

  it("'grange' stays retrieval-visible in hybrid top-5 while lookup fails closed", async () => {
    const entity = await lookup('grange');
    const hybrid = await search({
      query: 'grange',
      options: { explain: false, clarification: false },
    });

    expect(entity.status).toMatch(/^(failed|redirect_discovery)$/);
    expect(entity.top_candidate).toBeNull();
    expect(getSearchEntityIds(hybrid).slice(0, 5)).toContain('penfolds-grange-2017');
  });

  it('accented and accent-stripped Margaux queries do not fail', async () => {
    const accented = await lookup('Château Margaux');
    const stripped = await search({
      query: 'Chateau Margaux',
      options: { explain: false, clarification: false },
    });

    expect(accented.status).toMatch(/^(resolved|ambiguous)$/);
    expect(getSearchEntityIds(stripped).slice(0, 5)).toContain('chateau-margaux-2015');
  });
});

describe('Realistic Scenarios — vintage and specificity', () => {
  it("'Opus One' without a vintage resolves or abstains safely", async () => {
    const body = await lookup('Opus One');
    expect(body.status).toMatch(/^(resolved|ambiguous)$/);
  });

  it("'Sassicaia 2018' stays retrievable in hybrid top-5", async () => {
    const body = await search({
      query: 'Sassicaia 2018',
      options: { explain: false, clarification: false },
    });

    expect(getSearchEntityIds(body).slice(0, 5)).toContain('sassicaia-2018');
  });

  it("'2018 Cabernet' returns at least one Cabernet-led wine in the top-5", async () => {
    const cabernetIds = new Set(['opus-one-2018', 'chateau-margaux-2015', 'sassicaia-2018']);
    const body = await search({
      query: '2018 Cabernet',
      options: { explain: false, clarification: false },
    });

    const topFive = getSearchEntityIds(body).slice(0, 5);
    expect(topFive.some((entityId) => cabernetIds.has(entityId))).toBe(true);
  });
});

describe('Realistic Scenarios — semantic and multilingual smoke', () => {
  it.each([
    ['결혼식 샴페인', new Set(['moet-brut'])],
    ['스테이크랑 어울리는 와인', new Set(['opus-one-2018', 'penfolds-grange-2017', 'sassicaia-2018'])],
    ['Bordeaux 레드 와인', new Set(['chateau-margaux-2015', 'sauternes-2015'])],
    ['피노누아', new Set(['romanee-conti-2019'])],
  ])("'%s' keeps a representative candidate in the top-5", async (query, expectedIds) => {
    const body = await search({
      query,
      options: { explain: false, clarification: false },
    });

    const topFive = getSearchEntityIds(body).slice(0, 5);
    expect(topFive.some((entityId) => expectedIds.has(entityId))).toBe(true);
  });

  it("'아마로네 강한' returns non-empty results", async () => {
    const body = await search({
      query: '아마로네 강한',
      options: { explain: false, clarification: false },
    });

    expect(body.results.length).toBeGreaterThan(0);
    expect(getSearchMeta(body).route).toMatch(/^(hybrid|mixed)$/);
  });

  it("'호주 쉬라즈 풀바디' resolves Penfolds Grange at top-1", async () => {
    const body = await search({
      query: '호주 쉬라즈 풀바디',
      options: { explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toBe('resolved');
    expect(getSearchEntityIds(body)[0]).toBe('penfolds-grange-2017');
  });

  it("'상큼한 화이트 와인' resolves Cloudy Bay at top-1", async () => {
    const body = await search({
      query: '상큼한 화이트 와인',
      options: { explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toBe('resolved');
    expect(getSearchEntityIds(body)[0]).toBe('cloudy-bay-2022');
  });

  it("'풀바디 레드 와인' resolves as a list-shaped exploratory query", async () => {
    const body = await search({
      query: '풀바디 레드 와인',
      options: { explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toBe('resolved');
    expect(getSearchEntityIds(body).slice(0, 5)).toContain('opus-one-2018');
  });
});

describe('Benchmark #88 regression', () => {
  const query = '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로';

  it('returns a concrete recommendation path without clarification', async () => {
    const body = await search({
      query,
      options: { explain: false, clarification: false },
    });

    expect(getSearchDecisionStatus(body)).toBe('resolved');
    expect(body.engine_decision.next_action).toBe('return_result');
    expect(getSearchMeta(body).route).toBe('hybrid');
    expect(body.results.length).toBeGreaterThan(0);
  });
});

describe('Realistic Scenarios — graceful degradation', () => {
  it("'Petrus 2000' stays ambiguous or failed instead of crashing", async () => {
    const body = await lookup('Petrus 2000');
    expect(body.status).toMatch(/^(ambiguous|failed)$/);
  });
});

describe('Realistic Scenarios — route behavior', () => {
  it("query-driven routing keeps '오푸스원' on a supported fast-path", async () => {
    const body = await search({
      query: '오푸스원',
      options: { explain: false, clarification: false },
    });

    expect(getSearchMeta(body).route).toMatch(/^(entity|hybrid|mixed)$/);
  });

  it("query-driven routing sends '풀바디 레드 추천' to a retrieval path", async () => {
    const body = await search({
      query: '풀바디 레드 추천',
      options: { explain: false, clarification: false },
    });

    expect(getSearchMeta(body).route).toMatch(/^(hybrid|mixed)$/);
  });

  it("hybrid route keeps '오푸스원' in the top-5", async () => {
    const body = await search({
      query: '오푸스원',
      options: { explain: false, clarification: false },
    });

    expect(getSearchEntityIds(body).slice(0, 5)).toContain('opus-one-2018');
  });
});
