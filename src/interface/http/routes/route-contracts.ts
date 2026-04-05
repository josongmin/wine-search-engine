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
    207: BatchSearchResponseSchema,
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
