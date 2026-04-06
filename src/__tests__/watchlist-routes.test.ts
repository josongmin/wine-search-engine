import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WatchlistService } from '../application/watchlist/watchlist.service.js';
import { deepKeysToSnake } from '../interface/http/middleware/snake-case-hook.js';
import { registerWatchlistRoute } from '../interface/http/routes/watchlist.route.js';
import { AUTHENTICATED_SUBJECT_HEADER } from '../interface/http/authenticated-subject.js';
import { InMemoryWatchlistStore } from '../infrastructure/watchlist/in-memory-watchlist-store.js';

function authHeaders(subject = 'user-1'): Record<string, string> {
  return { [AUTHENTICATED_SUBJECT_HEADER]: subject };
}

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_id: 'wine-opus-one-2018',
    trigger_conditions: [
      {
        type: 'price_drop',
        threshold: 10,
        baseline_price: 150,
      },
    ],
    callback_url: 'https://example.com/webhook',
    ...overrides,
  };
}

describe('Watchlist Routes', () => {
  let app: FastifyInstance;
  let watchlistService: WatchlistService;

  beforeEach(() => {
    app = Fastify();
    watchlistService = new WatchlistService({
      storage: new InMemoryWatchlistStore(),
      idGenerator: randomUUID,
    });

    app.addHook('preSerialization', async (_request, _reply, payload: unknown) => {
      return deepKeysToSnake(payload);
    });

    registerWatchlistRoute(app, { watchlistService });
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires an authenticated subject header for watchlist create', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });

  it('creates entries from the authenticated subject and lists only that subject entries', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers: authHeaders('owner-1'),
      payload: createPayload(),
    });

    expect(createResponse.statusCode).toBe(201);
    const watchlistId = JSON.parse(createResponse.body).watchlist_id;

    const stored = await watchlistService.getByIdForUser({
      watchlistId,
      userId: 'owner-1',
    });
    expect(stored?.userId).toBe('owner-1');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/watchlist',
      headers: authHeaders('owner-1'),
    });

    expect(listResponse.statusCode).toBe(200);
    expect(JSON.parse(listResponse.body)).toEqual({
      entries: [
        expect.objectContaining({
          watchlist_id: watchlistId,
          user_id: 'owner-1',
          entity_id: 'wine-opus-one-2018',
        }),
      ],
      total: 1,
    });
  });

  it('returns 404 for cross-user watchlist reads and deletes', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers: authHeaders('owner-1'),
      payload: createPayload(),
    });
    const watchlistId = JSON.parse(createResponse.body).watchlist_id;

    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/watchlist/${watchlistId}`,
      headers: authHeaders('owner-2'),
    });
    expect(getResponse.statusCode).toBe(404);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/watchlist/${watchlistId}`,
      headers: authHeaders('owner-2'),
    });
    expect(deleteResponse.statusCode).toBe(404);
  });

  it('returns deliveries for owned entries and validates malformed ids after auth', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers: authHeaders('owner-1'),
      payload: createPayload(),
    });
    const watchlistId = JSON.parse(createResponse.body).watchlist_id;

    const deliveriesResponse = await app.inject({
      method: 'GET',
      url: `/v1/watchlist/${watchlistId}/deliveries`,
      headers: authHeaders('owner-1'),
    });
    expect(deliveriesResponse.statusCode).toBe(200);
    expect(JSON.parse(deliveriesResponse.body)).toEqual({
      deliveries: [],
      total: 0,
    });

    const badIdResponse = await app.inject({
      method: 'GET',
      url: '/v1/watchlist/not-a-uuid',
      headers: authHeaders('owner-1'),
    });
    expect(badIdResponse.statusCode).toBe(400);
  });
});
