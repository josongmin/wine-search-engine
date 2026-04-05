/**
 * Tests for watchlist HTTP routes.
 * Validates CRUD operations, delivery logging, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerWatchlistRoute } from '../interface/http/routes/watchlist.route.js';
import { deepKeysToSnake } from '../interface/http/middleware/snake-case-hook.js';
import { InMemoryWatchlistStore } from '../infrastructure/watchlist/in-memory-watchlist-store.js';
import { WatchlistService } from '../application/watchlist/watchlist.service.js';

describe('Watchlist Routes', () => {
  let app: FastifyInstance;
  let watchlistService: WatchlistService;

  beforeEach(async () => {
    app = Fastify();
    const store = new InMemoryWatchlistStore();
    watchlistService = new WatchlistService({
      watchlistRepository: store,
      deliveryLogRepository: store,
      idGenerator: randomUUID,
    });

    // Register snake_case serialization
    app.addHook('preSerialization', async (_request, _reply, payload: unknown) => {
      return deepKeysToSnake(payload);
    });

    // Register watchlist route
    registerWatchlistRoute(app, { watchlistService });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /v1/watchlist', () => {
    it('should create watchlist entry and return 201', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-opus-one-2018',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 10,
              baselinePrice: 150,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.watchlist_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should create entry with multiple triggers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-margaux-2015',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 5,
              baselinePrice: 900,
            },
            {
              type: 'critic_score_above',
              threshold: 95,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      const watchlistId = body.watchlist_id;

      // Verify entry was stored
      const stored = await watchlistService.getById(watchlistId);
      expect(stored).toBeDefined();
      expect(stored?.triggerConditions).toHaveLength(2);
    });

    it('should accept optional expiry', async () => {
      const expiryTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'new_vintage',
              minVintage: 2025,
            },
          ],
          callback_url: 'https://example.com/webhook',
          expires_at: expiryTime,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      const stored = await watchlistService.getById(body.watchlist_id);
      expect(stored?.expiresAt).toBeDefined();
    });

    it('should reject expiry in the past', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'new_vintage',
              minVintage: 2025,
            },
          ],
          callback_url: 'https://example.com/webhook',
          expires_at: '2020-01-01T00:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid user_id (not UUID)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: 'not-a-uuid',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 10,
              baselinePrice: 100,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid URL', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 10,
              baselinePrice: 100,
            },
          ],
          callback_url: 'not-a-url',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject empty trigger conditions', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [],
          callback_url: 'https://example.com/webhook',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/watchlist/:id', () => {
    it('should retrieve existing watchlist entry', async () => {
      // First create an entry
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 10,
              baselinePrice: 100,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      const watchlistId = JSON.parse(createResponse.body).watchlist_id;

      // Now retrieve it
      const getResponse = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${watchlistId}`,
      });

      expect(getResponse.statusCode).toBe(200);
      const body = JSON.parse(getResponse.body);
      expect(body.watchlist_id).toBe(watchlistId);
      expect(body.entity_id).toBe('wine-test');
      expect(body.user_id).toBe('550e8400-e29b-41d4-a716-446655440001');
    });

    it('should reject malformed watchlist id with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/watchlist/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for non-existent entry', async () => {
      const missingId = randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${missingId}`,
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('should include timestamps in ISO 8601 format', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'stock_available',
              minQty: 10,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      const watchlistId = JSON.parse(createResponse.body).watchlist_id;
      const getResponse = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${watchlistId}`,
      });

      const body = JSON.parse(getResponse.body);
      expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
      expect(body.expires_at).toBeNull(); // Since we didn't set it
    });
  });

  describe('DELETE /v1/watchlist/:id', () => {
    it('should delete watchlist entry and return 204', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'critic_score_above',
              threshold: 90,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      const watchlistId = JSON.parse(createResponse.body).watchlist_id;

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/v1/watchlist/${watchlistId}`,
      });

      expect(deleteResponse.statusCode).toBe(204);

      // Verify it's deleted
      const getResponse = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${watchlistId}`,
      });

      expect(getResponse.statusCode).toBe(404);
    });

    it('should return 404 for non-existent entry', async () => {
      const missingId = randomUUID();
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/watchlist/${missingId}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject malformed watchlist id with 400', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/watchlist/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/watchlist/:id/deliveries', () => {
    it('should return empty deliveries for new entry', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/v1/watchlist',
        payload: {
          user_id: '550e8400-e29b-41d4-a716-446655440001',
          entity_id: 'wine-test',
          trigger_conditions: [
            {
              type: 'price_drop',
              threshold: 5,
              baselinePrice: 200,
            },
          ],
          callback_url: 'https://example.com/webhook',
        },
      });

      const watchlistId = JSON.parse(createResponse.body).watchlist_id;

      const response = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${watchlistId}/deliveries`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.deliveries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should return 404 for non-existent entry', async () => {
      const missingId = randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/watchlist/${missingId}/deliveries`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject malformed watchlist id with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/watchlist/not-a-uuid/deliveries',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
