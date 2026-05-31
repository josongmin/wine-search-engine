import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ndcg, recall, reciprocalRank, type RankedHit, type RelevanceMap } from '../../scripts/eval/metrics.js';
import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { getSearchEntityIds, parseSearchResponse, postJson } from './helpers/http-transport.js';
import {
  QUERY_FAMILY_RELEASE_BASELINES,
  QUERY_FAMILY_RELEASE_THRESHOLDS,
  QUERY_FAMILY_RELEASE_BASELINE_VERSION,
  type ReleaseQueryFamily,
} from '../support/query-family-release-gate-baseline.js';

interface FamilyCase {
  readonly family: ReleaseQueryFamily;
  readonly query: string;
  readonly mode?: 'auto' | 'hybrid';
  readonly relevant?: RelevanceMap;
  readonly expectedTop1?: string | undefined;
  readonly excludedSeed?: string | undefined;
  readonly expectedDecisionStatus?: 'resolved' | 'ambiguous' | 'failed' | undefined;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

function relevance(entries: readonly [string, number][]): RelevanceMap {
  return { judgments: new Map(entries) };
}

async function search(caseDef: FamilyCase) {
  const response = await postJson(server.app, '/v1/search/hybrid', {
    query: caseDef.query,
    options: {
      mode: caseDef.mode ?? 'auto',
      explain: false,
      clarification: false,
    },
  });
  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

function toRankedHits(entityIds: readonly string[]): RankedHit[] {
  return entityIds.map((entityId, index) => ({
    entity_id: entityId,
    score: entityIds.length - index,
  }));
}

interface RankedMetrics {
  readonly ndcgAt10: number;
  readonly recallAt20: number;
  readonly mrrAt10: number;
}

function mean(
  rows: readonly RankedMetrics[],
  key: keyof RankedMetrics,
): number {
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
}

const CASES: readonly FamilyCase[] = [
  {
    family: 'entity_exact',
    query: 'Opus One 2018',
    mode: 'hybrid',
    expectedTop1: 'opus-one-2018',
    relevant: relevance([['opus-one-2018', 3]]),
  },
  {
    family: 'entity_exact',
    query: 'Sassicaia 2018',
    mode: 'hybrid',
    expectedTop1: 'sassicaia-2018',
    relevant: relevance([['sassicaia-2018', 3]]),
  },
  {
    family: 'pure_constraint',
    query: '풀바디 레드 와인',
    mode: 'hybrid',
    relevant: relevance([
      ['opus-one-2018', 3],
      ['chateau-margaux-2015', 2],
      ['sassicaia-2018', 2],
      ['penfolds-grange-2017', 2],
      ['barolo-giacomo', 1],
      ['masi-amarone', 1],
    ]),
  },
  {
    family: 'pure_constraint',
    query: '달달한 와인',
    mode: 'hybrid',
    relevant: relevance([['sauternes-2015', 3]]),
  },
  {
    family: 'pure_constraint',
    query: '상큼한 화이트 와인',
    mode: 'hybrid',
    relevant: relevance([['cloudy-bay-2022', 3]]),
  },
  {
    family: 'pure_constraint',
    query: '호주 쉬라즈 풀바디',
    mode: 'hybrid',
    relevant: relevance([['penfolds-grange-2017', 3]]),
  },
  {
    family: 'pure_constraint',
    query: '강한 타닌 네비올로',
    mode: 'hybrid',
    relevant: relevance([['barolo-giacomo', 3]]),
  },
  {
    family: 'anchored_similarity',
    query: '오푸스원 같은 와인',
    excludedSeed: 'opus-one-2018',
  },
  {
    family: 'anchored_similarity',
    query: '클라우디베이 말고 다른 화이트',
    excludedSeed: 'cloudy-bay-2022',
  },
  {
    family: 'pairing',
    query: '스테이크랑 어울리는 와인',
    mode: 'hybrid',
    relevant: relevance([
      ['opus-one-2018', 3],
      ['penfolds-grange-2017', 2],
      ['sassicaia-2018', 2],
    ]),
  },
  {
    family: 'browse',
    query: 'Bordeaux 레드 와인',
    mode: 'hybrid',
    relevant: relevance([
      ['chateau-margaux-2015', 3],
      ['sauternes-2015', 1],
    ]),
  },
  {
    family: 'browse',
    query: '스파클링 와인',
    mode: 'hybrid',
    relevant: relevance([['moet-brut', 3]]),
  },
  {
    family: 'situation_based',
    query: '결혼식 샴페인',
    mode: 'hybrid',
    relevant: relevance([['moet-brut', 3]]),
  },
  {
    family: 'situation_based',
    query: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
  },
  {
    family: 'no_match',
    query: '존재하지않는 와인 12345',
    mode: 'hybrid',
    expectedDecisionStatus: 'failed',
  },
] as const;

describe('Query Family Release Gate', () => {
  it(`keeps entity_exact non-regressing against ${QUERY_FAMILY_RELEASE_BASELINE_VERSION}`, async () => {
    const cases = CASES.filter((entry) => entry.family === 'entity_exact');
    const results = await Promise.all(cases.map(async (entry) => {
      const body = await search(entry);
      const entityIds = getSearchEntityIds(body);
      return {
        expectedTop1: entry.expectedTop1,
        top1: entityIds[0],
        top3Contains: entry.expectedTop1 !== undefined && entityIds.slice(0, 3).includes(entry.expectedTop1),
      };
    }));

    const wrongResolveRate = results.filter((entry) => entry.top1 !== entry.expectedTop1).length / results.length;
    const top3Recall = results.filter((entry) => entry.top3Contains).length / results.length;
    expect(wrongResolveRate, 'entity_exact wrong-resolve').toBeLessThanOrEqual(
      QUERY_FAMILY_RELEASE_BASELINES.entity_exact.wrongResolveRate
        + QUERY_FAMILY_RELEASE_THRESHOLDS.entityExactWrongResolveMaxIncrease,
    );
    expect(top3Recall, 'entity_exact top3 recall').toBeGreaterThanOrEqual(
      QUERY_FAMILY_RELEASE_BASELINES.entity_exact.top3Recall
        - QUERY_FAMILY_RELEASE_THRESHOLDS.entityExactTop3RecallMaxDrop,
    );
  });

  it(`keeps pure_constraint and situation_based zero-candidate non-regressing against ${QUERY_FAMILY_RELEASE_BASELINE_VERSION}`, async () => {
    for (const family of ['pure_constraint', 'situation_based'] as const) {
      const cases = CASES.filter((entry) => entry.family === family);
      const bodies = await Promise.all(cases.map((entry) => search(entry)));
      const zeroCandidateRate = bodies.filter((body) => body.results.length === 0).length / bodies.length;
      expect(zeroCandidateRate, `${family}: zero-candidate rate`).toBeLessThanOrEqual(
        QUERY_FAMILY_RELEASE_BASELINES[family].zeroCandidateRate
          + QUERY_FAMILY_RELEASE_THRESHOLDS.rankedFamilyZeroCandidateMaxIncrease,
      );
    }
  });

  it(`keeps anchored_similarity seed-exclusion non-regressing against ${QUERY_FAMILY_RELEASE_BASELINE_VERSION}`, async () => {
    const cases = CASES.filter((entry) => entry.family === 'anchored_similarity');
    const bodies = await Promise.all(cases.map((entry) => search(entry)));
    const seedExclusionPrecision = bodies.filter((body, index) =>
      body.results[0]?.entity.entity_id !== cases[index]?.excludedSeed,
    ).length / bodies.length;

    expect(seedExclusionPrecision).toBeGreaterThanOrEqual(
      QUERY_FAMILY_RELEASE_BASELINES.anchored_similarity.seedExclusionPrecision
        - QUERY_FAMILY_RELEASE_THRESHOLDS.anchoredSimilaritySeedExclusionMaxDrop,
    );
  });

  it(`keeps ranked families non-regressing against ${QUERY_FAMILY_RELEASE_BASELINE_VERSION}`, async () => {
    for (const family of ['pure_constraint', 'pairing', 'browse', 'situation_based'] as const) {
      const cases = CASES.filter((entry) => entry.family === family && entry.relevant !== undefined);
      const scored = await Promise.all(cases.map(async (entry) => {
        const body = await search(entry);
        const ranked = toRankedHits(getSearchEntityIds(body));
        return {
          ndcgAt10: ndcg(ranked, entry.relevant!, 10),
          recallAt20: recall(ranked, entry.relevant!, 20),
          mrrAt10: reciprocalRank(ranked, entry.relevant!, 10),
        };
      }));

      const baseline = QUERY_FAMILY_RELEASE_BASELINES[family];
      expect(mean(scored, 'ndcgAt10'), `${family}: ndcg@10`).toBeGreaterThanOrEqual(
        baseline.meanNdcgAt10 - QUERY_FAMILY_RELEASE_THRESHOLDS.rankedFamilyNdcgAt10MaxDrop,
      );
      expect(mean(scored, 'recallAt20'), `${family}: recall@20`).toBeGreaterThanOrEqual(
        baseline.meanRecallAt20 - QUERY_FAMILY_RELEASE_THRESHOLDS.rankedFamilyRecallAt20MaxDrop,
      );
      expect(mean(scored, 'mrrAt10'), `${family}: mrr@10`).toBeGreaterThanOrEqual(
        baseline.meanMrrAt10 - QUERY_FAMILY_RELEASE_THRESHOLDS.rankedFamilyMrrAt10MaxDrop,
      );
    }
  });

  it(`keeps no_match fail-closed against ${QUERY_FAMILY_RELEASE_BASELINE_VERSION}`, async () => {
    const cases = CASES.filter((entry) => entry.family === 'no_match');
    const bodies = await Promise.all(cases.map((entry) => search(entry)));
    const failClosedRate = bodies.filter((body, index) =>
      body.engine_decision.decision_status === cases[index]?.expectedDecisionStatus,
    ).length / bodies.length;

    expect(failClosedRate, 'no_match: fail-closed rate').toBeGreaterThanOrEqual(
      QUERY_FAMILY_RELEASE_BASELINES.no_match.failClosedRate
        - QUERY_FAMILY_RELEASE_THRESHOLDS.noMatchFailClosedMaxDrop,
    );
  });
});
