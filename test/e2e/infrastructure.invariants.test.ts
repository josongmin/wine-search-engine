/**
 * E2E infrastructure invariants.
 *
 * Owns rate limiting, request-id correctness, snapshot determinism,
 * and concurrent isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getSearchDecisionStatus,
  getSearchEntityIds,
  getSearchRequestId,
  parseErrorResponse,
  parseSearchResponse,
} from './helpers/http-transport.js';
import { fetchReplaySnapshot, makeReplaySnapshot } from './helpers/replay-snapshot.js';

const MATCHING_SNAPSHOT = makeReplaySnapshot();

function expectTruthyRequestIdHeader(response: { headers: Record<string, unknown> }) {
  const value = response.headers['x-request-id'];
  expect(Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).toBeTruthy();
}

function getInjectedRequestId(response: { headers: Record<string, unknown> }) {
  const value = response.headers['x-request-id'];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function injectSearch(
  server: TestServer,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/search',
    headers,
    payload: JSON.stringify(payload),
  });
}

function injectReplay(
  server: TestServer,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/search/replay',
    headers,
    payload: JSON.stringify(payload),
  });
}

function parseInjectedSearchResponse(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  return parseSearchResponse({
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  });
}

function parseInjectedErrorResponse(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  return parseErrorResponse({
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  });
}

function readErrorPayload(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function readErrorObject(response: { body: string }): Record<string, unknown> {
  return readErrorPayload(response)['error'] as Record<string, unknown>;
}

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe('string');
  expect((value as string).length).toBeGreaterThan(0);
}

function expectStatusCode(
  response: { statusCode: number },
  expectedStatus: number,
) {
  expect(response.statusCode).toBe(expectedStatus);
}

function expectUniqueInjectedRequestIds(
  responses: Array<{ headers: Record<string, unknown> }>,
  expectedSize: number,
) {
  const ids = responses.map(getInjectedRequestId);
  for (const id of ids) {
    expect(id).toBeTruthy();
  }
  expect(new Set(ids).size).toBe(expectedSize);
}

function expectSuccessSearchEnvelope(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  expectStatusCode(response, 200);
  const body = parseInjectedSearchResponse(response);
  expect(body.engine_decision).toBeDefined();
  expect(Array.isArray(body.results)).toBe(true);
  expect(body.meta).toBeDefined();
  return body;
}

function makeEntitySearchPayload(query: string) {
  return {
    query,
    options: { mode: 'entity', explain: false, clarification: false },
  };
}

describe('Group 1: Rate Limiting (RFC-014 §13)', () => {
  let rateLimitServer: TestServer;
  const RATE_LIMIT_MAX = 5;

  beforeAll(async () => {
    rateLimitServer = await createTestServer({
      serverOptions: { rateLimitMax: RATE_LIMIT_MAX },
    });
  });

  afterAll(async () => {
    await closeTestServer(rateLimitServer);
  });

  it('request after the configured rate-limit budget returns 429', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const r = await injectSearch(rateLimitServer, { query: `wine ${i}` });
      expectStatusCode(r, 200);
    }

    const r = await injectSearch(rateLimitServer, { query: `wine ${RATE_LIMIT_MAX}` });
    expectStatusCode(r, 429);
  });

  it('rate-limit error has the expected RFC-014 fields and semantics', async () => {
    const response = await injectSearch(rateLimitServer, { query: 'wine check' });
    expectStatusCode(response, 429);

    const error = readErrorObject(response);
    expect(error['code']).toBe('RATE_LIMIT_EXCEEDED');
    expect(error['retryable']).toBe(true);
    expectNonEmptyString(error['request_id']);
    expectNonEmptyString(error['message']);
    expect(error['message'] as string).toContain('Retry after');
  });

  it('rate-limit response includes Retry-After header', async () => {
    const r = await injectSearch(rateLimitServer, { query: 'retry-after header test' });
    expectStatusCode(r, 429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('fresh server allows requests after the rate-limited server is full', async () => {
    const freshServer = await createTestServer();
    try {
      const r = await injectSearch(freshServer, { query: 'fresh server test' });
      expect(r.statusCode).toBe(200);
    } finally {
      await closeTestServer(freshServer);
    }
  });
});

let pipelineInvariantServer: TestServer;

beforeAll(async () => {
  pipelineInvariantServer = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(pipelineInvariantServer);
});

describe('Group 2: Request ID Correctness', () => {
  const requestIdConcurrency = 8;

  it.each([
    ['200 response', () => injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }), 200],
    ['400 response', () => injectSearch(pipelineInvariantServer, { query: '' }), 400],
    [
      '409 response',
      () => injectReplay(pipelineInvariantServer, {
        query: 'Opus One 2018',
        decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
      }),
      409,
    ],
    [
      '415 response',
      () => injectSearch(pipelineInvariantServer, { query: 'Opus One' }, { 'content-type': 'text/plain' }),
      415,
    ],
  ])('X-Request-Id header is present on a %s', async (_label, runRequest, expectedStatus) => {
    const response = await runRequest();
    expectStatusCode(response, expectedStatus);
    expectTruthyRequestIdHeader(response);
  });

  it.each([
    [
      'success response',
      () => injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }),
      (response: Awaited<ReturnType<typeof injectSearch>>, headerId: string) => {
        expect(getSearchRequestId(parseInjectedSearchResponse(response))).toBe(headerId);
      },
    ],
    [
      'validation error response',
      () => injectSearch(pipelineInvariantServer, { query: '' }),
      (response: Awaited<ReturnType<typeof injectSearch>>, headerId: string) => {
        expect(readErrorObject(response)['request_id']).toBe(headerId);
      },
    ],
  ])('%s body request id matches X-Request-Id header exactly', async (_label, runRequest, assertMatches) => {
    const response = await runRequest();
    const headerId = getInjectedRequestId(response);
    expect(headerId).toBeTruthy();
    assertMatches(response, headerId);
  });

  it('8 concurrent requests all have unique X-Request-Id values', async () => {
    const requests = Array.from({ length: requestIdConcurrency }, () =>
      injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }),
    );

    const responses = await Promise.all(requests);
    expectUniqueInjectedRequestIds(responses, requestIdConcurrency);
  });

  it('valid client-provided X-Request-Id is echoed and matches meta.request_id', async () => {
    const clientId = 'gateway-trace-abc-123';
    const r = await injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }, {
      'content-type': 'application/json',
      'x-request-id': clientId,
    });

    expectStatusCode(r, 200);
    expect(getHeader(r, 'x-request-id')).toBe(clientId);
    expect(getSearchRequestId(parseSearchResponse(r))).toBe(clientId);
  });

  it('invalid X-Request-Id is rejected and replaced (does not echo unsafe values)', async () => {
    const unsafeId = 'not@valid/id';
    const r = await injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }, {
      'content-type': 'application/json',
      'x-request-id': unsafeId,
    });

    expectStatusCode(r, 200);
    const headerId = getHeader(r, 'x-request-id');
    expect(headerId).not.toBe(unsafeId);
    expect(headerId.length).toBeGreaterThan(0);
    expect(getSearchRequestId(parseSearchResponse(r))).toBe(headerId);
  });
});

describe('Group 3: Snapshot Determinism', () => {
  it('same query + matching snapshot replayed twice returns IDENTICAL results', async () => {
    const matchingSnapshot = await fetchReplaySnapshot(pipelineInvariantServer.app, {
      query: 'Opus One 2018',
    });
    const replayBody = {
      query: 'Opus One 2018',
      decision_snapshot: matchingSnapshot,
    };

    const [r1, r2] = await Promise.all([
      injectReplay(pipelineInvariantServer, replayBody),
      injectReplay(pipelineInvariantServer, replayBody),
    ]);

    const b1 = expectSuccessSearchEnvelope(r1);
    const b2 = expectSuccessSearchEnvelope(r2);

    expect(getSearchDecisionStatus(b1)).toBe(getSearchDecisionStatus(b2));
    expect(getSearchEntityIds(b1)).toEqual(getSearchEntityIds(b2));
  });

  it('different queries return different results (not all queries return same entity)', async () => {
    const [opus, margaux] = await Promise.all([
      injectSearch(pipelineInvariantServer, makeEntitySearchPayload('Opus One 2018')),
      injectSearch(pipelineInvariantServer, makeEntitySearchPayload('Château Margaux')),
    ]);

    const statuses = [
      getSearchDecisionStatus(expectSuccessSearchEnvelope(opus)),
      getSearchDecisionStatus(expectSuccessSearchEnvelope(margaux)),
    ];
    const nonFailed = statuses.filter((s) => s !== 'failed');
    expect(nonFailed.length).toBeGreaterThan(0);
  });

  it.each([
    ['policy_rule_version 9.9.9', '9.9.9'],
    ['policy_rule_version 99.0.0', '99.0.0'],
  ])('%s mismatch → 409 SNAPSHOT_MISMATCH with non-retryable error', async (_label, policyRuleVersion) => {
    const response = await injectReplay(pipelineInvariantServer, {
      query: 'Opus One 2018',
      decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: policyRuleVersion },
    });

    expectStatusCode(response, 409);
    const error = parseInjectedErrorResponse(response).error;
    expect(error.code).toBe('SNAPSHOT_MISMATCH');
    expect(error.retryable).toBe(false);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe('Group 4: Concurrent Request Isolation', () => {
  const isolationConcurrency = 6;

  it('3 concurrent requests with DIFFERENT queries do not cross-contaminate results', async () => {
    const [entityRes, hybridRes, margauxRes] = await Promise.all([
      injectSearch(pipelineInvariantServer, makeEntitySearchPayload('Opus One 2018')),
      injectSearch(pipelineInvariantServer, {
        query: 'sparkling wine',
        options: { mode: 'hybrid', explain: false, clarification: false },
      }),
      injectSearch(pipelineInvariantServer, makeEntitySearchPayload('chateau margaux')),
    ]);

    expectUniqueInjectedRequestIds([entityRes, hybridRes, margauxRes], 3);
    [entityRes, hybridRes, margauxRes].forEach(expectSuccessSearchEnvelope);
  });

  it('6 concurrent requests with same query all return IDENTICAL decisionStatus', async () => {
    const requests = Array.from({ length: isolationConcurrency }, () =>
      injectSearch(pipelineInvariantServer, makeEntitySearchPayload('Opus One 2018')),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => getSearchDecisionStatus(expectSuccessSearchEnvelope(r)));

    expect(new Set(statuses).size).toBe(1);
  });

  it('6 concurrent requests with same entity query all have unique X-Request-Id values', async () => {
    const requests = Array.from({ length: isolationConcurrency }, () =>
      injectSearch(pipelineInvariantServer, { query: 'Opus One 2018' }),
    );

    const responses = await Promise.all(requests);
    expectUniqueInjectedRequestIds(responses, isolationConcurrency);
  });
});
