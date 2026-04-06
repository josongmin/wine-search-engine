/**
 * E2E tests for subject-scoped watchlist routes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHENTICATED_SUBJECT_HEADER } from '../../src/interface/http/authenticated-subject.js';
import {
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  ListWatchlistResponseSchema,
  WatchlistErrorResponseSchema,
} from '../../src/interface/http/schemas/watchlist.schema.js';
import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import { getHeader, getJson, postJson } from './helpers/http-transport.js';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await closeTestServer(server);
});

function authHeaders(subject = 'user-1'): Record<string, string> {
  return { [AUTHENTICATED_SUBJECT_HEADER]: subject };
}

function buildCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  it('requires an authenticated subject header', async () => {
    const res = await postJson(server.app, '/v1/watchlist', buildCreatePayload());

    expect(res.statusCode).toBe(401);
    expect(WatchlistErrorResponseSchema.parse(res.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('creates a watchlist entry and returns a UUID watchlist_id', async () => {
    const res = await postJson(
      server.app,
      '/v1/watchlist',
      buildCreatePayload(),
      authHeaders('owner-1'),
    );

    expect(res.statusCode).toBe(201);
    expect(getHeader(res, 'x-request-id')).toBeTruthy();

    const parsed = CreateWatchlistResponseSchema.parse(res.json());
    expect(parsed.watchlist_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('Watchlist CRUD flow', () => {
  it('creates, lists, retrieves, lists deliveries, deletes, and 404s cross-user access', async () => {
    const createRes = await postJson(
      server.app,
      '/v1/watchlist',
      buildCreatePayload({
        entity_id: 'chateau-margaux-2015',
        trigger_conditions: [
          {
            type: 'new_vintage',
            min_vintage: 2025,
          },
        ],
      }),
      authHeaders('owner-1'),
    );

    expect(createRes.statusCode).toBe(201);
    const watchlistId = CreateWatchlistResponseSchema.parse(createRes.json()).watchlist_id;

    const listRes = await getJson(server.app, '/v1/watchlist', authHeaders('owner-1'));
    expect(listRes.statusCode).toBe(200);
    const listParsed = ListWatchlistResponseSchema.parse(listRes.json());
    expect(listParsed.total).toBeGreaterThanOrEqual(1);
    expect(listParsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          watchlist_id: watchlistId,
          user_id: 'owner-1',
          entity_id: 'chateau-margaux-2015',
        }),
      ]),
    );

    const getRes = await getJson(server.app, `/v1/watchlist/${watchlistId}`, authHeaders('owner-1'));
    expect(getRes.statusCode).toBe(200);
    expect(getHeader(getRes, 'x-request-id')).toBeTruthy();

    const getParsed = GetWatchlistResponseSchema.parse(getRes.json());
    expect(getParsed.watchlist_id).toBe(watchlistId);
    expect(getParsed.user_id).toBe('owner-1');
    expect(getParsed.entity_id).toBe('chateau-margaux-2015');

    const deliveriesRes = await getJson(
      server.app,
      `/v1/watchlist/${watchlistId}/deliveries`,
      authHeaders('owner-1'),
    );
    expect(deliveriesRes.statusCode).toBe(200);
    expect(ListDeliveriesResponseSchema.parse(deliveriesRes.json()).total).toBe(0);

    const crossUserRes = await getJson(
      server.app,
      `/v1/watchlist/${watchlistId}`,
      authHeaders('owner-2'),
    );
    expect(crossUserRes.statusCode).toBe(404);

    const deleteRes = await server.app.inject({
      method: 'DELETE',
      url: `/v1/watchlist/${watchlistId}`,
      headers: authHeaders('owner-1'),
    });
    expect(deleteRes.statusCode).toBe(204);
    expect(deleteRes.body).toBe('');

    const missingRes = await getJson(
      server.app,
      `/v1/watchlist/${watchlistId}`,
      authHeaders('owner-1'),
    );
    expect(missingRes.statusCode).toBe(404);
    expect(WatchlistErrorResponseSchema.parse(missingRes.json()).error.code).toBe('NOT_FOUND');
  });
});
