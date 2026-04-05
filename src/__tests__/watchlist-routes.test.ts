/**
 * Tests for watchlist HTTP routes.
 * Validates CRUD operations, delivery logging, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWatchlistRoute, clearWatchlistStores, getWatchlistEntry } from '../interface/http/routes/watchlist.route.js';
import { deepKeysToSnake } from '../interface/http/middleware/snake-case-hook.js';

describe('Watchlist Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    clearWatchlistStores();

    // Register snake_case serialization
    app.addHook('preSerialization', async (_request, _reply, payload: unknown) => {
      return deepKeysToSnake(payload);
    });

    // Register watchlist route
    registerWatchlistRoute(app);
  });

  afterEach(async () => {
    await app.close();
    clearWatchlistStores();
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
      expect(body.watchlist_id).toMatch(/^[\w-]+$/); // nanoid format
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
      const stored = getWatchlistEntry(watchlistId);
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
      const stored = getWatchlistEntry(body.watchlist_id);
      expect(stored?.expiresAt).toBeDefined();
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
      expect(body.id).toBe(watchlistId);
      expect(body.entity_id).toBe('wine-test');
      expect(body.user_id).toBe('550e8400-e29b-41d4-a716-446655440001');
    });

    it('should return 404 for non-existent entry', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/watchlist/nonexistent-id',
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
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/watchlist/nonexistent-id',
      });

      expect(response.statusCode).toBe(404);
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
      const response = await app.inject({
        method: 'GET',
        url: '/v1/watchlist/nonexistent-id/deliveries',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
