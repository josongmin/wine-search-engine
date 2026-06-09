import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import {
  EntityLookupV2ResponseSchema,
  type EntityLookupV2Response,
} from '../../../src/interface/http/schemas/entity-lookup-v2.schema.js';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  type ComparisonSearchResponseBody,
  type ErrorResponseBody,
  type SearchResponseBody,
} from '../../../src/interface/http/schemas/search-response.schema.js';

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
      `${label} schema validation failed: ${JSON.stringify(parsed.error.flatten(), null, 2)}; raw_body=${response.body}`,
    );
  }
  return parsed.data;
}

export function parseSearchResponse(response: JsonHttpResponse): SearchResponseBody {
  return parseWithSchema(response, SearchResponseSchema, 'search response');
}

export function parseEntityLookupResponse(response: JsonHttpResponse): EntityLookupV2Response {
  return parseWithSchema(response, EntityLookupV2ResponseSchema, 'entity-lookup response');
}

export function parseComparisonResponse(response: JsonHttpResponse): ComparisonSearchResponseBody {
  return parseWithSchema(response, ComparisonSearchResponseSchema, 'comparison response');
}

export function parseErrorResponse(response: JsonHttpResponse): ErrorResponseBody {
  return parseWithSchema(response, ErrorResponseSchema, 'error response');
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
