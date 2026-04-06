/**
 * E2E tests for POST/GET/DELETE /v1/watchlist and deliveries.
 *
 * Covers the full server path, snake_case transport, request-id/header
 * assertions, and failure-path behavior.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, closeTestServer, type TestServer } from './helpers/test-server.js';
import {
  getHeader,
  getJson,
  postJson,
} from './helpers/http-transport.js';
import {
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  WatchlistErrorResponseSchema,
} from '../../src/interface/http/schemas/watchlist.schema.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

function buildCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: randomUUID(),
    entity_id: 'opus-one-2018',
    trigger_conditions: [
      {
        type: 'price_drop',
        threshold: 10,
        baseline_price: 150,
      },
    ],
    callback_url: 'https://example.com/webhook',
    expires_at: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /v1/watchlist', () => {
  it('creates a watchlist entry and returns a UUID watchlist_id', async () => {
    const res = await postJson(server.app, '/v1/watchlist', buildCreatePayload());

    expect(res.statusCode).toBe(201);
    expect(getHeader(res, 'x-request-id')).toBeTruthy();

    const parsed = CreateWatchlistResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    expect(parsed.data.watchlist_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects invalid payloads with a 400 watchlist error envelope', async () => {
    const res = await postJson(server.app, '/v1/watchlist', buildCreatePayload({
      callback_url: 'not-a-url',
    }));

    expect(res.statusCode).toBe(400);

    const headerRequestId = getHeader(res, 'x-request-id');
    expect(headerRequestId).toBeTruthy();

    const parsed = WatchlistErrorResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    expect(parsed.data.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.data.error.message).toMatch(/watchlist/i);
    expect(parsed.data.error.request_id).toBe(headerRequestId);
  });
});

describe('Watchlist CRUD flow', () => {
  it('creates, retrieves, lists deliveries, deletes, and 404s after deletion', async () => {
    const createRes = await postJson(server.app, '/v1/watchlist', buildCreatePayload({
      entity_id: 'chateau-margaux-2015',
      trigger_conditions: [
        {
          type: 'new_vintage',
          min_vintage: 2025,
        },
      ],
    }));

    expect(createRes.statusCode).toBe(201);
    const watchlistId = (CreateWatchlistResponseSchema.parse(createRes.json())).watchlist_id;

    const getRes = await getJson(server.app, `/v1/watchlist/${watchlistId}`);
    expect(getRes.statusCode).toBe(200);
    expect(getHeader(getRes, 'x-request-id')).toBeTruthy();

    const getParsed = GetWatchlistResponseSchema.safeParse(getRes.json());
    expect(getParsed.success).toBe(true);
    if (!getParsed.success) {
      throw new Error(getParsed.error.message);
    }

    expect(getParsed.data.watchlist_id).toBe(watchlistId);
    expect(getParsed.data.user_id).toBeDefined();
    expect(getParsed.data.entity_id).toBe('chateau-margaux-2015');
    expect(getParsed.data.trigger_conditions).toHaveLength(1);
    expect(getParsed.data.callback_url).toBe('https://example.com/webhook');
    expect(getParsed.data.expires_at).toBe('2030-01-01T00:00:00.000Z');

    const deliveriesRes = await getJson(server.app, `/v1/watchlist/${watchlistId}/deliveries`);
    expect(deliveriesRes.statusCode).toBe(200);
    expect(getHeader(deliveriesRes, 'x-request-id')).toBeTruthy();

    const deliveriesParsed = ListDeliveriesResponseSchema.safeParse(deliveriesRes.json());
    expect(deliveriesParsed.success).toBe(true);
    if (!deliveriesParsed.success) {
      throw new Error(deliveriesParsed.error.message);
    }

    expect(deliveriesParsed.data.total).toBe(0);
    expect(deliveriesParsed.data.deliveries).toHaveLength(0);

    const deleteRes = await server.app.inject({
      method: 'DELETE',
      url: `/v1/watchlist/${watchlistId}`,
    });

    expect(deleteRes.statusCode).toBe(204);
    expect(getHeader({
      statusCode: deleteRes.statusCode,
      headers: deleteRes.headers as Record<string, string | string[]>,
      body: deleteRes.body,
      json: () => null,
    }, 'x-request-id')).toBeTruthy();
    expect(deleteRes.body).toBe('');

    const missingRes = await getJson(server.app, `/v1/watchlist/${watchlistId}`);
    expect(missingRes.statusCode).toBe(404);

    const missingHeaderRequestId = getHeader(missingRes, 'x-request-id');
    expect(missingHeaderRequestId).toBeTruthy();

    const missingParsed = WatchlistErrorResponseSchema.safeParse(missingRes.json());
    expect(missingParsed.success).toBe(true);
    if (!missingParsed.success) {
      throw new Error(missingParsed.error.message);
    }

    expect(missingParsed.data.error.code).toBe('NOT_FOUND');
    expect(missingParsed.data.error.request_id).toBe(missingHeaderRequestId);
  });
});
