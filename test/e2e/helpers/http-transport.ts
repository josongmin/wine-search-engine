import type { FastifyInstance } from 'fastify';
import { z, type ZodType } from 'zod';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  InterpretResponseSchema,
  ResolveResponseSchema,
  SearchResponseSchema,
  type ComparisonSearchResponseBody,
  type ErrorResponseBody,
  type InterpretResponseBody,
  type ResolveResponseBody,
  type SearchResponseBody,
} from '../../../src/interface/http/schemas/search-response.schema.js';
import {
  BatchSearchResponseSchema,
  type BatchSearchResponseBody,
} from '../../../src/interface/http/schemas/batch-search.schema.js';

export interface JsonHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
  json(): unknown;
}

export async function postJson(
  app: FastifyInstance,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<JsonHttpResponse> {
  const response = await app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    payload: JSON.stringify(body),
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  };
}

export async function getJson(
  app: FastifyInstance,
  path: string,
  headers?: Record<string, string>,
): Promise<JsonHttpResponse> {
  const response = await app.inject({
    method: 'GET',
    url: path,
    headers,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
  };
}

export async function optionsRequest(
  app: FastifyInstance,
  path: string,
  headers?: Record<string, string>,
): Promise<JsonHttpResponse> {
  const response = await app.inject({
    method: 'OPTIONS',
    url: path,
    headers,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body,
    json: () => (response.body.length > 0 ? JSON.parse(response.body) as unknown : null),
  };
}

export function getHeader(response: JsonHttpResponse, name: string): string {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseWithSchema<T>(
  response: JsonHttpResponse,
  schema: ZodType<T>,
  label: string,
): T {
  const parsed = schema.safeParse(response.json());
  if (!parsed.success) {
    throw new Error(
      `${label} schema validation failed: ${JSON.stringify(z.treeifyError(parsed.error), null, 2)}`,
    );
  }
  return parsed.data;
}

export function parseSearchResponse(response: JsonHttpResponse): SearchResponseBody {
  return parseWithSchema(response, SearchResponseSchema, 'search response');
}

export function parseComparisonResponse(response: JsonHttpResponse): ComparisonSearchResponseBody {
  return parseWithSchema(response, ComparisonSearchResponseSchema, 'comparison response');
}

export function parseErrorResponse(response: JsonHttpResponse): ErrorResponseBody {
  return parseWithSchema(response, ErrorResponseSchema, 'error response');
}

export function parseInterpretResponse(response: JsonHttpResponse): InterpretResponseBody {
  return parseWithSchema(response, InterpretResponseSchema, 'interpret response');
}

export function parseResolveResponse(response: JsonHttpResponse): ResolveResponseBody {
  return parseWithSchema(response, ResolveResponseSchema, 'resolve response');
}

export function parseBatchSearchResponse(response: JsonHttpResponse): BatchSearchResponseBody {
  return parseWithSchema(response, BatchSearchResponseSchema, 'batch search response');
}

export function getSearchDecision(body: SearchResponseBody): SearchResponseBody['engine_decision'] {
  return body.engine_decision;
}

export function getSearchMeta(body: SearchResponseBody): SearchResponseBody['meta'] {
  return body.meta;
}

export function getSearchRequestId(body: SearchResponseBody): string {
  return body.meta.request_id ?? '';
}

export function getSearchDecisionStatus(body: SearchResponseBody): string {
  return body.engine_decision.decision_status;
}

export function getSearchDecisionSnapshot(
  body: SearchResponseBody,
): SearchResponseBody['engine_decision']['decision_snapshot'] {
  return body.engine_decision.decision_snapshot;
}

export function getSearchEntityIds(body: SearchResponseBody): string[] {
  return body.results.map((result) => result.entity.entity_id);
}

export function getSearchRelevanceScores(body: SearchResponseBody): number[] {
  return body.results.map((result) => result.relevance_score);
}

export function getSearchEvidenceItems(
  body: SearchResponseBody,
  index: number,
): SearchResponseBody['results'][number]['evidence_items'] {
  const result = body.results[index];
  return result?.evidence_items ?? [];
}
