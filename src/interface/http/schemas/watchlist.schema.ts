/**
 * Epic 17.1: Watchlist HTTP Request/Response Schemas
 *
 * Zod schemas for watchlist CRUD operations and delivery log queries.
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────
// Trigger condition schemas
// ────────────────────────────────────────────────────────────────

const NewVintageTriggerSchema = z.object({
  type: z.literal('new_vintage'),
  minVintage: z.number().int().positive(),
}).strict();

const PriceDropTriggerSchema = z.object({
  type: z.literal('price_drop'),
  threshold: z.number().min(0).max(100), // percentage
  baselinePrice: z.number().positive(),
}).strict();

const StockAvailableTriggerSchema = z.object({
  type: z.literal('stock_available'),
  minQty: z.number().int().positive(),
}).strict();

const CriticScoreAboveTriggerSchema = z.object({
  type: z.literal('critic_score_above'),
  threshold: z.number().min(0).max(100),
}).strict();

export const WatchlistTriggerSchema = z.discriminatedUnion('type', [
  NewVintageTriggerSchema,
  PriceDropTriggerSchema,
  StockAvailableTriggerSchema,
  CriticScoreAboveTriggerSchema,
]);

export type WatchlistTrigger = z.infer<typeof WatchlistTriggerSchema>;

// ────────────────────────────────────────────────────────────────
// Create watchlist entry request
// ────────────────────────────────────────────────────────────────

export const CreateWatchlistRequestSchema = z.object({
  user_id: z.string().uuid(),
  entity_id: z.string().min(1).max(256),
  trigger_conditions: z.array(WatchlistTriggerSchema).min(1).max(10),
  callback_url: z.string().url().max(2048),
  expires_at: z.string().datetime().optional(), // ISO 8601
}).strict();

export type CreateWatchlistRequest = z.infer<typeof CreateWatchlistRequestSchema>;

// ────────────────────────────────────────────────────────────────
// Create watchlist entry response
// ────────────────────────────────────────────────────────────────

export const CreateWatchlistResponseSchema = z.object({
  watchlist_id: z.string().uuid(),
});

export type CreateWatchlistResponse = z.infer<typeof CreateWatchlistResponseSchema>;

// ────────────────────────────────────────────────────────────────
// Get watchlist entry by ID response
// ────────────────────────────────────────────────────────────────

export const GetWatchlistResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  entity_id: z.string().min(1),
  trigger_conditions: z.array(WatchlistTriggerSchema),
  callback_url: z.string().url(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
}).strict();

export type GetWatchlistResponse = z.infer<typeof GetWatchlistResponseSchema>;

// ────────────────────────────────────────────────────────────────
// Delivery log entry
// ────────────────────────────────────────────────────────────────

export const DeliveryLogEntrySchema = z.object({
  id: z.string().uuid(),
  watchlist_id: z.string().uuid(),
  attempt: z.number().int().min(1).max(3),
  status_code: z.number().int().min(0).nullable(),
  error_message: z.string().nullable(),
  delivered_at: z.string().datetime(),
}).strict();

export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntrySchema>;

// ────────────────────────────────────────────────────────────────
// List deliveries response
// ────────────────────────────────────────────────────────────────

export const ListDeliveriesResponseSchema = z.object({
  deliveries: z.array(DeliveryLogEntrySchema),
  total: z.number().int().nonnegative(),
}).strict();

export type ListDeliveriesResponse = z.infer<typeof ListDeliveriesResponseSchema>;

// ────────────────────────────────────────────────────────────────
// Error response (shared)
// ────────────────────────────────────────────────────────────────

export const WatchlistErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }),
}).strict();

export type WatchlistErrorResponse = z.infer<typeof WatchlistErrorResponseSchema>;
