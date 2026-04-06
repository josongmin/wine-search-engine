import { z } from 'zod';
import {
  BatchSearchRequestSchema,
  BatchSearchResponseSchema,
} from '../schemas/batch-search.schema.js';
import {
  HybridRequestSchema,
  InterpretRequestSchema,
  ReplayRequestSchema,
  ResolveRequestSchema,
  SearchRequestSchema,
} from '../schemas/search-request.schema.js';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  InterpretResponseSchema,
  ResolveResponseSchema,
  SearchResponseSchema,
} from '../schemas/search-response.schema.js';
import {
  CreateWatchlistRequestSchema,
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  WatchlistErrorResponseSchema,
  WatchlistIdParamsSchema,
} from '../schemas/watchlist.schema.js';
import {
  PostFeedbackRequestSchema,
  PostFeedbackResponseSchema,
} from '../schemas/feedback.schema.js';

type ResponseSchema = z.ZodTypeAny | null;

export interface HttpRouteContract {
  readonly operationId: string;
  readonly body?: z.ZodTypeAny;
  readonly params?: z.ZodTypeAny;
  readonly responses: Readonly<Record<number, ResponseSchema>>;
}

function defineRouteContract<T extends HttpRouteContract>(contract: T): T {
  return Object.freeze(contract);
}

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.string(),
  uptime: z.number(),
});

const ReadyResponseSchema = z.object({
  ready: z.boolean(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['up', 'down', 'skipped']),
    required: z.boolean(),
  })),
});

const ClaudeToolsExecuteRequestSchema = z.object({
  tool_name: z.string().min(1),
  tool_input: z.record(z.unknown()).optional().default({}),
  request_id: z.string().optional(),
});

const ClaudeToolsExecuteResponseSchema = z.object({
  tool_name: z.string(),
  tool_result: z.unknown(),
  fallback_applied: z.string().optional(),
  request_id: z.string(),
});

const ClaudeToolsErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string(),
});

const ClaudeToolsListResponseSchema = z.object({
  tools: z.array(z.unknown()),
  request_id: z.string(),
});

export const HealthRouteContract = defineRouteContract({
  operationId: 'system.health',
  responses: {
    200: HealthResponseSchema,
  },
});

export const ReadyRouteContract = defineRouteContract({
  operationId: 'system.ready',
  responses: {
    200: ReadyResponseSchema,
    503: ReadyResponseSchema,
  },
});

export const ClaudeToolsExecuteRouteContract = defineRouteContract({
  operationId: 'tools.execute',
  body: ClaudeToolsExecuteRequestSchema,
  responses: {
    200: ClaudeToolsExecuteResponseSchema,
    400: ClaudeToolsErrorResponseSchema,
    500: ClaudeToolsErrorResponseSchema,
  },
});

export const ClaudeToolsListRouteContract = defineRouteContract({
  operationId: 'tools.list',
  responses: {
    200: ClaudeToolsListResponseSchema,
  },
});

export const SearchRouteContract = defineRouteContract({
  operationId: 'search.execute',
  body: SearchRequestSchema,
  responses: {
    200: z.union([SearchResponseSchema, ComparisonSearchResponseSchema]),
    400: ErrorResponseSchema,
    403: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const HybridRouteContract = defineRouteContract({
  operationId: 'search.hybrid',
  body: HybridRequestSchema,
  responses: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    403: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const InterpretRouteContract = defineRouteContract({
  operationId: 'search.interpret',
  body: InterpretRequestSchema,
  responses: {
    200: InterpretResponseSchema,
    400: ErrorResponseSchema,
    403: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const ResolveRouteContract = defineRouteContract({
  operationId: 'entity.resolve',
  body: ResolveRequestSchema,
  responses: {
    200: ResolveResponseSchema,
    400: ErrorResponseSchema,
    403: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const ReplayRouteContract = defineRouteContract({
  operationId: 'search.replay',
  body: ReplayRequestSchema,
  responses: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    409: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const BatchSearchRouteContract = defineRouteContract({
  operationId: 'search.batch',
  body: BatchSearchRequestSchema,
  responses: {
    200: BatchSearchResponseSchema,
    400: ErrorResponseSchema,
    429: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
});

export const WatchlistCreateRouteContract = defineRouteContract({
  operationId: 'watchlist.create',
  body: CreateWatchlistRequestSchema,
  responses: {
    201: CreateWatchlistResponseSchema,
    400: WatchlistErrorResponseSchema,
    500: WatchlistErrorResponseSchema,
  },
});

export const WatchlistGetRouteContract = defineRouteContract({
  operationId: 'watchlist.get',
  params: WatchlistIdParamsSchema,
  responses: {
    200: GetWatchlistResponseSchema,
    400: WatchlistErrorResponseSchema,
    404: WatchlistErrorResponseSchema,
    500: WatchlistErrorResponseSchema,
  },
});

export const WatchlistDeleteRouteContract = defineRouteContract({
  operationId: 'watchlist.delete',
  params: WatchlistIdParamsSchema,
  responses: {
    204: null,
    400: WatchlistErrorResponseSchema,
    404: WatchlistErrorResponseSchema,
    500: WatchlistErrorResponseSchema,
  },
});

export const WatchlistDeliveriesRouteContract = defineRouteContract({
  operationId: 'watchlist.listDeliveries',
  params: WatchlistIdParamsSchema,
  responses: {
    200: ListDeliveriesResponseSchema,
    400: WatchlistErrorResponseSchema,
    404: WatchlistErrorResponseSchema,
    500: WatchlistErrorResponseSchema,
  },
});

export const FeedbackSubmitRouteContract = defineRouteContract({
  operationId: 'learning.submitFeedback',
  body: PostFeedbackRequestSchema,
  responses: {
    201: PostFeedbackResponseSchema,
    400: ErrorResponseSchema,
    503: ErrorResponseSchema,
  },
});
