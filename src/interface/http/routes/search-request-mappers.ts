import { type z } from 'zod';
import type {
  SearchQueryBudget,
  SearchRequestContext,
  SearchRequest,
} from '../../../application/search/search-request.dto.js';
import type { PrimitiveSearchRequestSchema } from '../schemas/primitive-search.schema.js';

// ---------------------------------------------------------------------------
// T-IR-01 primitive surface mappers — path-authoritative.
//
// Each primitive endpoint owns a dedicated mapper; the URL path is the
// authority for which retrieval lane runs. The request body is identical
// across the four primitives (see {@link PrimitiveSearchRequestSchema}) so
// callers can switch primitives without reshaping their payload.
// ---------------------------------------------------------------------------

type PrimitiveSearchBody = z.output<typeof PrimitiveSearchRequestSchema>;

function primitiveAliases(body: PrimitiveSearchBody): {
  readonly context?: SearchRequestContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
  readonly filters?: SearchRequest['filters'];
  readonly preferences?: SearchRequest['preferences'];
  readonly limit?: number | undefined;
} {
  return {
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.queryBudget !== undefined ? { queryBudget: body.queryBudget } : {}),
    ...(body.filters !== undefined ? { filters: body.filters } : {}),
    ...(body.preferences !== undefined ? { preferences: body.preferences } : {}),
    ...(body.limit !== undefined ? { limit: body.limit } : {}),
  };
}

export function toHybridSearchRequest(body: PrimitiveSearchBody): SearchRequest {
  return {
    query: body.query,
    ...primitiveAliases(body),
    retrievalLane: 'hybrid',
  };
}

export function toSemanticSearchRequest(body: PrimitiveSearchBody): SearchRequest {
  return {
    query: body.query,
    ...primitiveAliases(body),
    retrievalLane: 'semantic_only',
  };
}

export function toLexicalSearchRequest(body: PrimitiveSearchBody): SearchRequest {
  return {
    query: body.query,
    ...primitiveAliases(body),
    retrievalLane: 'lexical_only',
  };
}

