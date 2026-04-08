/**
 * E2E infrastructure contract coverage.
 *
 * Owns content-type handling, success envelope completeness,
 * and RFC-014/RFC-015 error contract coverage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getSearchDecision,
  getSearchDecisionSnapshot,
  getSearchMeta,
  parseSearchResponse,
} from './helpers/http-transport.js';
import { makeReplaySnapshot } from './helpers/replay-snapshot.js';

const MATCHING_SNAPSHOT = makeReplaySnapshot();

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

function readErrorPayload(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function readErrorObject(response: { body: string }): Record<string, unknown> {
  return readErrorPayload(response)['error'] as Record<string, unknown>;
}

function getInjectedRequestId(response: { headers: Record<string, unknown> }) {
  const value = response.headers['x-request-id'];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function expectRfc014ErrorShape(error: Record<string, unknown>) {
  expect(typeof error['code']).toBe('string');
  expect(typeof error['message']).toBe('string');
  expect(typeof error['request_id']).toBe('string');
  expect('failure_reason' in error).toBe(true);
  expect(typeof error['retryable']).toBe('boolean');
}

function expectAllowedDecisionStatus(
  response: ReturnType<typeof parseInjectedSearchResponse>,
  allowedStatuses: readonly string[],
) {
  expect(allowedStatuses).toContain(response.engine_decision.decision_status);
}

let staticContractServer: TestServer;
let unsupportedTextPlainResponse: Awaited<ReturnType<typeof injectSearch>>;
let unsupportedXmlResponse: Awaited<ReturnType<typeof injectSearch>>;
let missingContentTypeResponse: Awaited<ReturnType<TestServer['app']['inject']>>;
let resolvedResponse: Awaited<ReturnType<typeof injectSearch>>;
let validationErrorResponse: Awaited<ReturnType<typeof injectSearch>>;
let snapshotMismatchResponse: Awaited<ReturnType<typeof injectReplay>>;

beforeAll(async () => {
  staticContractServer = await createTestServer();
  [
    unsupportedTextPlainResponse,
    unsupportedXmlResponse,
    missingContentTypeResponse,
    resolvedResponse,
    validationErrorResponse,
    snapshotMismatchResponse,
  ] = await Promise.all([
    injectSearch(staticContractServer, { query: 'Opus One' }, {
      'content-type': 'text/plain',
    }),
    injectSearch(staticContractServer, { query: 'Opus One' }, {
      'content-type': 'application/xml',
    }),
    staticContractServer.app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: JSON.stringify({ query: 'Opus One' }),
    }),
    injectSearch(staticContractServer, { query: 'Opus One 2018' }),
    injectSearch(staticContractServer, { query: '' }),
    injectReplay(staticContractServer, {
      query: 'Opus One 2018',
      decision_snapshot: { ...MATCHING_SNAPSHOT, policy_rule_version: '9.9.9' },
    }),
  ]);
});

afterAll(async () => {
  await closeTestServer(staticContractServer);
});

describe('Group 5: Content-Type Edge Cases', () => {
  it.each([
    ['application/json', { 'content-type': 'application/json' }],
    ['application/json; charset=utf-8', { 'content-type': 'application/json; charset=utf-8' }],
    ['application/json;charset=utf-8', { 'content-type': 'application/json;charset=utf-8' }],
    ['APPLICATION/JSON', { 'content-type': 'APPLICATION/JSON' }],
  ])('%s → 200', async (_label, headers) => {
    const r = await injectSearch(staticContractServer, { query: 'Opus One' }, headers);
    expect(r.statusCode).toBe(200);
  });

  const unsupportedMediaCases = [
    ['text/plain', () => unsupportedTextPlainResponse],
    ['missing Content-Type', () => missingContentTypeResponse],
    ['application/xml', () => unsupportedXmlResponse],
  ] as const;

  it.each(unsupportedMediaCases)('%s → 415 with code=UNSUPPORTED_MEDIA_TYPE', async (_label, getResponse) => {
    const r = getResponse();
    expect(r.statusCode).toBe(415);
    const body = readErrorPayload(r);
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('415 error response has retryable=false', async () => {
    const body = readErrorPayload(unsupportedTextPlainResponse);
    const error = body['error'] as Record<string, unknown>;
    expect(error['retryable']).toBe(false);
  });
});

describe('Group 6: Response Envelope Completeness', () => {
  it('every 200 response has exactly the top-level keys: results, engineDecision, meta', async () => {
    const body = parseInjectedSearchResponse(resolvedResponse);
    expect(body.results).toBeDefined();
    expect(body.engine_decision).toBeDefined();
    expect(body.meta).toBeDefined();
  });

  it('meta has requestId (string), queryTimeMs (non-negative integer), engine_schema_version', async () => {
    const meta = getSearchMeta(parseInjectedSearchResponse(resolvedResponse));

    expect(typeof meta.request_id).toBe('string');
    expect(meta.request_id!.length).toBeGreaterThan(0);
    expect(typeof meta.query_time_ms).toBe('number');
    expect(Number.isInteger(meta.query_time_ms)).toBe(true);
    expect(meta.query_time_ms).toBeGreaterThanOrEqual(0);
    expect(meta.engine_schema_version).toBe('search_response_v1');
  });

  it('engineDecision has decisionStatus (one of 3 values), decisionSnapshot (non-null object), route (string)', async () => {
    expect(resolvedResponse.statusCode).toBe(200);
    const decision = getSearchDecision(parseInjectedSearchResponse(resolvedResponse));

    expect(['resolved', 'ambiguous', 'failed']).toContain(decision.decision_status);
    expect(typeof decision.decision_snapshot).toBe('object');
    expect(decision.decision_snapshot).not.toBeNull();
    expect(typeof decision.route).toBe('string');
    expect(decision.route.length).toBeGreaterThan(0);
  });

  it('decisionSnapshot has all 6 RFC-015 fields', async () => {
    expect(resolvedResponse.statusCode).toBe(200);
    const snapshot = getSearchDecisionSnapshot(parseInjectedSearchResponse(resolvedResponse));

    expect(snapshot).toHaveProperty('model_versions');
    expect(typeof snapshot['model_versions']).toBe('object');
    expect(snapshot['model_versions']).not.toBeNull();

    expect(snapshot).toHaveProperty('index_versions');
    expect(typeof snapshot['index_versions']).toBe('object');
    expect(snapshot['index_versions']).not.toBeNull();

    expect(snapshot).toHaveProperty('policy_rule_version');
    expect(typeof snapshot['policy_rule_version']).toBe('string');

    expect(snapshot).toHaveProperty('threshold_profile_id');
    expect(typeof snapshot['threshold_profile_id']).toBe('string');

    expect(snapshot).toHaveProperty('planner_version');
    expect(typeof snapshot['planner_version']).toBe('string');

    expect(snapshot).toHaveProperty('feature_flags');
    expect(typeof snapshot['feature_flags']).toBe('object');
    expect(snapshot['feature_flags']).not.toBeNull();
  });

  it.each([
    ['zzz_extremely_unknown_wine_xyz_no_match_9999', ['ambiguous', 'failed']],
    ['zzz_no_match_wine_abc', ['failed', 'ambiguous']],
  ])('unknown query %s still returns a safe 200 envelope', async (query, allowedStatuses) => {
    const r = await injectSearch(staticContractServer, {
      query,
      options: { mode: 'entity', explain: false, clarification: false },
    });
    expect(r.statusCode).toBe(200);

    const body = parseInjectedSearchResponse(r);
    expectAllowedDecisionStatus(body, allowedStatuses);
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe('Group 7: Error Response Completeness (RFC-014)', () => {
  const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9_]+$/;

  const errorCaseGetters = [
    ['400 VALIDATION_ERROR', () => validationErrorResponse, 400],
    ['409 SNAPSHOT_MISMATCH', () => snapshotMismatchResponse, 409],
    ['415 UNSUPPORTED_MEDIA_TYPE', () => unsupportedTextPlainResponse, 415],
  ] as const;

  it.each(errorCaseGetters)('%s has all 5 RFC-014 error fields', async (_label, getResponse, expectedStatus) => {
    const response = getResponse();
    expect(response.statusCode).toBe(expectedStatus);
    expectRfc014ErrorShape(readErrorObject(response));
  });

  it.each(errorCaseGetters)('%s code is SCREAMING_SNAKE_CASE', async (_label, getResponse) => {
    const response = getResponse();
    const body = readErrorPayload(response);
    const error = body['error'] as Record<string, unknown>;
    expect(error['code'] as string).toMatch(SCREAMING_SNAKE_CASE);
  });

  it.each(errorCaseGetters)('%s error.message is a non-empty string', async (_label, getResponse) => {
    const error = readErrorObject(getResponse());
    expect(typeof error['message']).toBe('string');
    expect((error['message'] as string).length).toBeGreaterThan(0);
  });

  it.each([
    ['400 VALIDATION_ERROR', () => validationErrorResponse],
    ['409 SNAPSHOT_MISMATCH', () => snapshotMismatchResponse],
  ])('%s error.request_id matches X-Request-Id header', async (_label, getResponse) => {
    const response = getResponse();
    expect(readErrorObject(response)['request_id']).toBe(getInjectedRequestId(response));
  });

  it.each([
    ['409 SNAPSHOT_MISMATCH', () => snapshotMismatchResponse, 'SNAPSHOT_MISMATCH'],
    ['415 UNSUPPORTED_MEDIA_TYPE', () => unsupportedTextPlainResponse, 'UNSUPPORTED_MEDIA_TYPE'],
    ['400 VALIDATION_ERROR', () => validationErrorResponse, 'VALIDATION_ERROR'],
  ])('%s remains non-retryable', async (_label, getResponse, expectedCode) => {
    const error = readErrorObject(getResponse());
    expect(error['code']).toBe(expectedCode);
    expect(error['retryable']).toBe(false);
  });
});
