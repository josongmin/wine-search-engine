/**
 * Epic 17.1: Watchlist HTTP Request/Response Schemas
 *
 * Zod schemas for watchlist CRUD operations and delivery log queries.
 */

import { z } from 'zod';
import { AUTHENTICATED_SUBJECT_HEADER } from '../authenticated-subject.js';

const WatchlistIdSchema = z.string().uuid();
const AuthenticatedSubjectSchema = z.string().min(1).max(128);
const HttpsUrlSchema = z.string().url().max(2048).refine(
  (value) => value.startsWith('https://'),
  'callback_url must use https',
);
const FutureDateTimeSchema = z.string().datetime().refine(
  (value) => new Date(value).getTime() > Date.now(),
  'expires_at must be in the future',
);

const NewVintageTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('new_vintage'),
    min_vintage: z.number().int().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    minVintage: value.min_vintage,
  })),
  z.object({
    type: z.literal('new_vintage'),
    minVintage: z.number().int().positive(),
  }).strict(),
]);

const PriceDropTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().min(0).max(100),
    baseline_price: z.number().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    threshold: value.threshold,
    baselinePrice: value.baseline_price,
  })),
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().min(0).max(100),
    baselinePrice: z.number().positive(),
  }).strict(),
]);

const StockAvailableTriggerRequestSchema = z.union([
  z.object({
    type: z.literal('stock_available'),
    min_qty: z.number().int().positive(),
  }).strict().transform((value) => ({
    type: value.type,
    minQty: value.min_qty,
  })),
  z.object({
    type: z.literal('stock_available'),
    minQty: z.number().int().positive(),
  }).strict(),
]);

const CriticScoreAboveTriggerRequestSchema = z.object({
  type: z.literal('critic_score_above'),
  threshold: z.number().min(0).max(100),
}).strict();

export const WatchlistTriggerSchema = z.union([
  NewVintageTriggerRequestSchema,
  PriceDropTriggerRequestSchema,
  StockAvailableTriggerRequestSchema,
  CriticScoreAboveTriggerRequestSchema,
]);

export const WatchlistTriggerResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new_vintage'),
    min_vintage: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('price_drop'),
    threshold: z.number().min(0).max(100),
    baseline_price: z.number().positive(),
  }).strict(),
  z.object({
    type: z.literal('stock_available'),
    min_qty: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('critic_score_above'),
    threshold: z.number().min(0).max(100),
  }).strict(),
]);

export type WatchlistTrigger = z.infer<typeof WatchlistTriggerSchema>;
export type WatchlistTriggerResponse = z.infer<typeof WatchlistTriggerResponseSchema>;

export const WatchlistIdParamsSchema = z.object({
  id: WatchlistIdSchema,
}).strict();

export type WatchlistIdParams = z.infer<typeof WatchlistIdParamsSchema>;

export const WatchlistAuthHeadersSchema = z.object({
  [AUTHENTICATED_SUBJECT_HEADER]: AuthenticatedSubjectSchema,
}).strict();

export type WatchlistAuthHeaders = z.infer<typeof WatchlistAuthHeadersSchema>;

export const CreateWatchlistRequestSchema = z.object({
  entity_id: z.string().min(1).max(256),
  trigger_conditions: z.array(WatchlistTriggerSchema).min(1).max(10),
  callback_url: HttpsUrlSchema,
  expires_at: FutureDateTimeSchema.optional(),
}).strict();

export type CreateWatchlistRequest = z.infer<typeof CreateWatchlistRequestSchema>;

export const CreateWatchlistResponseSchema = z.object({
  watchlist_id: WatchlistIdSchema,
}).strict();

export type CreateWatchlistResponse = z.infer<typeof CreateWatchlistResponseSchema>;

export const GetWatchlistResponseSchema = z.object({
  watchlist_id: WatchlistIdSchema,
  user_id: AuthenticatedSubjectSchema,
  entity_id: z.string().min(1),
  trigger_conditions: z.array(WatchlistTriggerResponseSchema),
  callback_url: HttpsUrlSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
}).strict();

export type GetWatchlistResponse = z.infer<typeof GetWatchlistResponseSchema>;

export const ListWatchlistResponseSchema = z.object({
  entries: z.array(GetWatchlistResponseSchema),
  total: z.number().int().nonnegative(),
}).strict();

export type ListWatchlistResponse = z.infer<typeof ListWatchlistResponseSchema>;

export const DeliveryLogEntrySchema = z.object({
  id: WatchlistIdSchema,
  watchlist_id: WatchlistIdSchema,
  attempt: z.number().int().min(1).max(4),
  status_code: z.number().int().min(0).nullable(),
  error_message: z.string().nullable(),
  delivered_at: z.string().datetime(),
}).strict();

export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntrySchema>;

export const ListDeliveriesResponseSchema = z.object({
  deliveries: z.array(DeliveryLogEntrySchema),
  total: z.number().int().nonnegative(),
}).strict();

export type ListDeliveriesResponse = z.infer<typeof ListDeliveriesResponseSchema>;

export const WatchlistErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }).strict(),
}).strict();

export type WatchlistErrorResponse = z.infer<typeof WatchlistErrorResponseSchema>;
