import { type z } from 'zod';
import type {
  SearchOptions,
  SearchQueryBudget,
  SearchRequestContext,
  SearchRequest,
  SearchSessionContext,
} from '../../../application/search/search-request.dto.js';
import {
  type LookupRequestSchema,
  type SearchRequestSchema,
} from '../schemas/search-request.schema.js';
import type { PrimitiveSearchRequestSchema } from '../schemas/primitive-search.schema.js';

interface NormalizedRequestAliases {
  readonly context?: SearchRequestContext | undefined;
  readonly sessionContext?: SearchSessionContext | undefined;
  readonly queryBudget?: SearchQueryBudget | undefined;
}

function extractNormalizedAliases(body: unknown): NormalizedRequestAliases {
  const candidate = body as Partial<NormalizedRequestAliases>;
  return {
    ...(candidate.context !== undefined ? { context: candidate.context } : {}),
    ...(candidate.sessionContext !== undefined
      ? { sessionContext: candidate.sessionContext }
      : {}),
    ...(candidate.queryBudget !== undefined ? { queryBudget: candidate.queryBudget } : {}),
  };
}

function normalizeSearchOptions(
  options: z.output<typeof SearchRequestSchema>['options'],
): SearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    mode: options.mode,
    explain: options.explain,
    clarification: options.clarification,
  };
}

/**
 * Maps a lookup request body to a SearchRequest with retrieval_mode forced to
 * 'entity'. The caller cannot override routing — lookup is always entity-only.
 *
 * `options.mode` is intentionally omitted: routing is non-negotiable.
 * `clarification` is always false: lookup callers want a direct answer,
 *   not a "did you mean?" deflection.
 */
export function toLookupRequest(body: z.output<typeof LookupRequestSchema>): SearchRequest {
  const aliases = extractNormalizedAliases(body);
  // Always inject options so clarification:false is honoured even when the
  // caller omits the options object entirely.
  const options: SearchOptions = {
    mode: 'auto',
    explain: body.options?.explain ?? false,
    clarification: false,
  };
  return {
    query: body.query,
    ...aliases,
    options,
    retrieval_mode: 'entity',
  };
}

export function toSearchRequest(body: z.output<typeof SearchRequestSchema>): SearchRequest {
  const options = normalizeSearchOptions(body.options);
  const aliases = extractNormalizedAliases(body);
  return {
    query: body.query,
    ...aliases,
    ...(options !== undefined ? { options } : {}),
    ...(body.retrieval_mode !== undefined ? { retrieval_mode: body.retrieval_mode } : {}),
  };
}

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
    retrieval_mode: 'hybrid',
    retrievalLane: 'hybrid',
  };
}

export function toSemanticSearchRequest(body: PrimitiveSearchBody): SearchRequest {
  return {
    query: body.query,
    ...primitiveAliases(body),
    retrieval_mode: 'hybrid',
    retrievalLane: 'semantic_only',
  };
}

export function toLexicalSearchRequest(body: PrimitiveSearchBody): SearchRequest {
  return {
    query: body.query,
    ...primitiveAliases(body),
    retrieval_mode: 'hybrid',
    retrievalLane: 'lexical_only',
  };
}

export function toLookupWineRequest(body: PrimitiveSearchBody): SearchRequest {
  // Lookup is decisive — clarification 'did you mean?' deflections are not the
  // job of `/v1/lookup/wine`. Comparison queries are rejected at the route
  // handler (see {@link lookup-wine.route.ts}), not papered over here.
  const options: SearchOptions = {
    mode: 'auto',
    explain: false,
    clarification: false,
  };
  return {
    query: body.query,
    ...primitiveAliases(body),
    options,
    retrieval_mode: 'entity',
  };
}
