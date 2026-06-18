import fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNdjson } from '../../scripts/etl/ndjson.js';
import type { GoldenQuery } from '../../scripts/etl/types.js';
import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchEntityIds,
  parseEntityLookupResponse,
  parseSearchResponse,
  postJson,
} from './helpers/http-transport.js';

interface SmokeCase {
  readonly qid: string;
  readonly query: string;
  readonly queryClass: GoldenQuery['query_class'];
  readonly retrievalMode: GoldenQuery['retrieval_mode'];
  readonly expectedDecisionStatus: GoldenQuery['decision_labels']['expected_decision_status'];
  readonly expectedEntityId: string | null;
}

let server: TestServer;
let cases: readonly SmokeCase[];

beforeAll(async () => {
  server = await createTestServer();
  const content = await fs.readFile('data/eval-smoke-queries.jsonl', 'utf8');
  const { records } = parseNdjson<GoldenQuery>(
    content,
    'data/eval-smoke-queries.jsonl',
  );
  cases = records.map((record) => ({
    qid: record.qid,
    query: record.query,
    queryClass: record.query_class,
    retrievalMode: record.retrieval_mode,
    expectedDecisionStatus: record.decision_labels.expected_decision_status,
    expectedEntityId: record.decision_labels.expected_entity_id ?? null,
  }));
});

afterAll(async () => {
  await closeTestServer(server);
});

async function search(query: string) {
  const response = await postJson(server.app, '/v1/search/hybrid', {
    query,
    options: {
      explain: false,
      clarification: false,
    },
  });
  expect(response.statusCode).toBe(200);
  return parseSearchResponse(response);
}

async function lookup(query: string) {
  const response = await postJson(server.app, '/v2/entity-lookup', { query });
  expect(response.statusCode).toBe(200);
  return parseEntityLookupResponse(response);
}

describe('Offline Smoke Release Gate', () => {
  it('keeps the active smoke corpus at or above the current floor', () => {
    const exactCases = cases.filter((entry) => entry.queryClass === 'exact_entity');
    const semanticCases = cases.filter((entry) => entry.queryClass === 'semantic_preference');
    const ambiguousCases = cases.filter((entry) => entry.queryClass === 'ambiguous_short_form');
    const noMatchCases = cases.filter((entry) => entry.queryClass === 'no_match');

    expect(exactCases.length).toBeGreaterThanOrEqual(10);
    expect(semanticCases.length).toBeGreaterThanOrEqual(6);
    expect(ambiguousCases.length).toBeGreaterThanOrEqual(1);
    expect(noMatchCases.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps exact-entity top1 recovery at 100%', async () => {
    const exactCases = cases.filter((entry) =>
      entry.queryClass === 'exact_entity'
      && entry.retrievalMode === 'entity_lookup',
    );
    const bodies = await Promise.all(exactCases.map((entry) => lookup(entry.query)));
    const top1Accuracy = bodies.filter((body, index) =>
      body.status === exactCases[index]?.expectedDecisionStatus
      && body.top_candidate?.entity_id === exactCases[index]?.expectedEntityId,
    ).length / exactCases.length;

    expect(top1Accuracy).toBe(1);
  });

  it('keeps semantic-preference expected entities in the top-3', async () => {
    const semanticCases = cases.filter((entry) => entry.queryClass === 'semantic_preference');
    const bodies = await Promise.all(semanticCases.map((entry) => search(entry.query)));
    const top3Coverage = bodies.filter((body, index) => {
      const expectedEntityId = semanticCases[index]?.expectedEntityId;
      return expectedEntityId !== null && getSearchEntityIds(body).slice(0, 3).includes(expectedEntityId);
    }).length / semanticCases.length;

    expect(top3Coverage).toBe(1);
  });

  it('keeps ambiguous-short-form queries safe', async () => {
    const ambiguousCases = cases.filter((entry) => entry.queryClass === 'ambiguous_short_form');
    const bodies = await Promise.all(ambiguousCases.map((entry) => search(entry.query)));
    const safeRate = bodies.filter((body, index) => {
      const expectedEntityId = ambiguousCases[index]?.expectedEntityId;
      return body.engine_decision.decision_status === 'ambiguous'
        && expectedEntityId !== null
        && getSearchEntityIds(body).slice(0, 3).includes(expectedEntityId);
    }).length / ambiguousCases.length;

    expect(safeRate).toBe(1);
  });

  it('keeps no-match queries fail-closed', async () => {
    const noMatchCases = cases.filter((entry) => entry.queryClass === 'no_match');
    const bodies = await Promise.all(noMatchCases.map((entry) => search(entry.query)));
    const failClosedRate = bodies.filter((body) =>
      body.engine_decision.decision_status === 'failed',
    ).length / noMatchCases.length;

    expect(failClosedRate).toBe(1);
  });
});
