/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import { z } from 'zod';
import { DeclaredHttpRouteContractCatalog } from './http-route-contract-catalog.js';
import { camelToSnake } from '../middleware/snake-case-hook.js';
import {
  HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
  HTTP_SUCCESS_STATUS_MIN,
} from '../constants.js';

export interface OpenApiBridgeOperation {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly 'x-search-capabilities'?: readonly string[] | undefined;
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: 'path' | 'header';
    readonly required: boolean;
    readonly schema: OpenApiBridgeSchema;
  }[] | undefined;
  readonly requestBody?: {
    readonly required: true;
    readonly content: {
      readonly 'application/json': {
        readonly schema: OpenApiBridgeSchema;
      };
    };
  } | undefined;
  readonly responses: Readonly<Record<string, OpenApiBridgeResponse>>;
  readonly 'x-contract-has-body': boolean;
  readonly 'x-contract-has-params': boolean;
  readonly 'x-contract-success-status-codes': readonly number[];
  readonly 'x-contract-error-status-codes': readonly number[];
  /** API version tag derived from the route contract (e.g. '2' for V2 routes). */
  readonly 'x-version'?: string | undefined;
  /** Response type tag for V2 routes (e.g. 'human' or 'interpret'). */
  readonly 'x-response-type'?: string | undefined;
}

export interface OpenApiBridgeResponse {
  readonly description: string;
  readonly content?: {
    readonly 'application/json': {
      readonly schema: OpenApiBridgeSchema;
    };
  };
}

export type OpenApiBridgeSchema =
  | { readonly type: 'string'; readonly enum?: readonly string[]; readonly format?: string; readonly minLength?: number; readonly maxLength?: number }
  | { readonly type: 'number' | 'integer'; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'null' }
  | { readonly type: 'array'; readonly items: OpenApiBridgeSchema }
  | { readonly type: 'object'; readonly properties?: Record<string, OpenApiBridgeSchema>; readonly required?: readonly string[]; readonly additionalProperties?: boolean | OpenApiBridgeSchema }
  | { readonly oneOf: readonly OpenApiBridgeSchema[] }
  | { readonly anyOf: readonly OpenApiBridgeSchema[] }
  | { readonly allOf: readonly OpenApiBridgeSchema[] }
  | Record<string, unknown>;

export interface OpenApiBridgeDocument {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: 'Wine Search Engine HTTP Contract Bridge';
    readonly version: '1.0.0';
    readonly description: string;
  };
  readonly paths: Readonly<Record<string, Partial<Record<'get' | 'post' | 'delete' | 'put' | 'patch', OpenApiBridgeOperation>>>>;
}

interface ZodCheck {
  readonly kind: string;
  readonly value?: number;
}

interface ZodEffectsDef {
  readonly schema: z.ZodTypeAny;
}

interface ZodDefaultDef {
  readonly innerType: z.ZodTypeAny;
}

interface ZodLiteralDef {
  readonly value: unknown;
}

interface ZodRecordDef {
  readonly valueType: z.ZodTypeAny;
}

interface ZodUnionDef {
  readonly options: readonly z.ZodTypeAny[];
}

interface ZodIntersectionDef {
  readonly left: z.ZodTypeAny;
  readonly right: z.ZodTypeAny;
}

interface ZodTupleDef {
  readonly items: readonly z.ZodTypeAny[];
}

interface ZodDiscriminatedUnionDef {
  readonly options: readonly z.ZodDiscriminatedUnionOption<string>[];
}

function toOpenApiPath(url: string): string {
  return url.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function inferTag(operationId: string): string {
  const [prefix] = operationId.split('.');
  return prefix ?? 'http';
}

function inferPathParameters(
  url: string,
  paramsSchema: z.ZodTypeAny | undefined,
): OpenApiBridgeOperation['parameters'] {
  if (paramsSchema === undefined) {
    return undefined;
  }

  const unwrapped = unwrapSchema(paramsSchema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1] ?? 'id',
      in: 'path' as const,
      required: true as const,
      schema: { type: 'string' as const },
    }));
  }

  return getObjectEntries(unwrapped).map(([name, schema]) => ({
    name,
    in: 'path' as const,
    required: true as const,
    schema: zodToOpenApiSchema(schema),
  }));
}

function inferHeaderParameters(
  headersSchema: z.ZodTypeAny | undefined,
): OpenApiBridgeOperation['parameters'] {
  if (headersSchema === undefined) {
    return undefined;
  }

  const unwrapped = unwrapSchema(headersSchema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return undefined;
  }

  return getObjectEntries(unwrapped).map(([name, schema]) => ({
    name,
    in: 'header' as const,
    required: !isOptionalSchema(schema),
    schema: zodToOpenApiSchema(schema),
  }));
}

function describeResponse(statusCode: number): string {
  if (statusCode >= HTTP_SUCCESS_STATUS_MIN && statusCode < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE) {
    return `Successful response (${statusCode})`;
  }
  return `Error response (${statusCode})`;
}

function buildResponse(
  statusCode: number,
  schema: z.ZodTypeAny | null,
): OpenApiBridgeResponse {
  const description = describeResponse(statusCode);
  if (schema === null) {
    return { description };
  }

  return {
    description,
    content: {
      'application/json': {
        schema: zodToOpenApiSchema(schema),
      },
    },
  };
}

export function buildHttpRouteContractOpenApiBridge(): OpenApiBridgeDocument {
  const paths: Record<string, Partial<Record<'get' | 'post' | 'delete' | 'put' | 'patch', OpenApiBridgeOperation>>> = {};

  for (const entry of DeclaredHttpRouteContractCatalog) {
    const pathKey = toOpenApiPath(entry.url);
    const methodKey = entry.method.toLowerCase() as 'get' | 'post' | 'delete' | 'put' | 'patch';
    const statusCodes = Object.keys(entry.contract.responses)
      .map((statusCode) => Number(statusCode))
      .sort((left, right) => left - right);
    const successStatusCodes = statusCodes.filter(
      (statusCode) => statusCode >= HTTP_SUCCESS_STATUS_MIN && statusCode < HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
    );
    const errorStatusCodes = statusCodes.filter(
      (statusCode) => statusCode < HTTP_SUCCESS_STATUS_MIN || statusCode >= HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE,
    );

    const operation: OpenApiBridgeOperation = {
      operationId: entry.contract.operationId,
      tags: [inferTag(entry.contract.operationId)],
      ...(entry.contract.capabilities !== undefined
        ? { 'x-search-capabilities': entry.contract.capabilities }
        : {}),
      ...(entry.contract.apiVersion !== undefined
        ? { 'x-version': entry.contract.apiVersion }
        : {}),
      ...(entry.contract.responseType !== undefined
        ? { 'x-response-type': entry.contract.responseType }
        : {}),
      responses: Object.fromEntries(
        statusCodes.map((statusCode) => [
          String(statusCode),
          buildResponse(statusCode, entry.contract.responses[statusCode] ?? null),
        ]),
      ),
      'x-contract-has-body': entry.contract.body !== undefined,
      'x-contract-has-params': entry.contract.params !== undefined,
      'x-contract-success-status-codes': successStatusCodes,
      'x-contract-error-status-codes': errorStatusCodes,
      ...(entry.contract.body !== undefined
        ? {
            requestBody: {
              required: true as const,
              content: {
                'application/json': {
                  schema: zodToOpenApiSchema(entry.contract.body),
                },
              },
            },
          }
        : {}),
      ...((entry.contract.params !== undefined || entry.contract.headers !== undefined)
        ? {
            parameters: [
              ...(inferPathParameters(entry.url, entry.contract.params) ?? []),
              ...(inferHeaderParameters(entry.contract.headers) ?? []),
            ],
          }
        : {}),
    };

    const existing = paths[pathKey] ?? {};
    existing[methodKey] = operation;
    paths[pathKey] = existing;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Wine Search Engine HTTP Contract Bridge',
      version: '1.0.0',
      description: 'OpenAPI bridge generated from declared route contracts. Schemas remain Zod-backed in runtime code.',
    },
    paths,
  };
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional
    || current instanceof z.ZodNullable
    || current instanceof z.ZodDefault
    || current instanceof z.ZodEffects
  ) {
    if (current instanceof z.ZodEffects) {
      current = getEffectsSchema(current);
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = getDefaultInnerType(current);
      continue;
    }
    current = (current as z.ZodOptional<z.ZodTypeAny> | z.ZodNullable<z.ZodTypeAny>).unwrap();
  }
  return current;
}

function zodToOpenApiSchema(schema: z.ZodTypeAny): OpenApiBridgeSchema {
  const current = unwrapSchema(schema);

  if (current instanceof z.ZodString) {
    const checks = getChecks(current);
    const minLength = checks.find((check) => check.kind === 'min')?.value;
    const maxLength = checks.find((check) => check.kind === 'max')?.value;
    const isUuid = checks.some((check) => check.kind === 'uuid');
    return {
      type: 'string',
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(isUuid ? { format: 'uuid' } : {}),
    };
  }

  if (current instanceof z.ZodNumber) {
    const checks = getChecks(current);
    const minimum = checks.find((check) => check.kind === 'min')?.value;
    const maximum = checks.find((check) => check.kind === 'max')?.value;
    const isInteger = checks.some((check) => check.kind === 'int');
    return {
      type: isInteger ? 'integer' : 'number',
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  }

  if (current instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }

  if (current instanceof z.ZodNull) {
    return { type: 'null' };
  }

  if (current instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: [...current.options],
    };
  }

  if (current instanceof z.ZodNativeEnum) {
    return {
      type: 'string',
      enum: Object.values(current.enum).filter((value): value is string => typeof value === 'string'),
    };
  }

  if (current instanceof z.ZodLiteral) {
    const value = getLiteralValue(current);
    if (typeof value === 'string') {
      return { type: 'string', enum: [value] };
    }
    if (typeof value === 'number') {
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    }
    if (typeof value === 'boolean') {
      return { type: 'boolean' };
    }
    if (value === null) {
      return { type: 'null' };
    }
    return {};
  }

  if (current instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodToOpenApiSchema(current.element),
    };
  }

  if (current instanceof z.ZodTuple) {
    const tupleItems = getTupleItems(current);
    // OpenAPI 3.1 tuple representation: fixed-length array with prefixItems.
    return {
      type: 'array',
      prefixItems: tupleItems.map((item) => zodToOpenApiSchema(item)),
      minItems: tupleItems.length,
      maxItems: tupleItems.length,
    } as OpenApiBridgeSchema;
  }

  if (current instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: zodToOpenApiSchema(getRecordValueType(current)),
    };
  }

  if (current instanceof z.ZodObject) {
    const properties: Record<string, OpenApiBridgeSchema> = {};
    const required: string[] = [];

    for (const [key, value] of getObjectEntries(current)) {
      // Convert camelCase schema keys to snake_case so the OpenAPI spec
      // matches the actual wire format (preSerialization hook applies
      // deepKeysToSnake to all outbound payloads).  Already-snake_case
      // keys pass through unchanged (camelToSnake is idempotent).
      const wireKey = camelToSnake(key);
      properties[wireKey] = zodToOpenApiSchema(value);
      if (!isOptionalSchema(value)) {
        required.push(wireKey);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  if (current instanceof z.ZodUnion) {
    return {
      oneOf: getUnionOptions(current).map((option) => zodToOpenApiSchema(option)),
    };
  }

  if (current instanceof z.ZodDiscriminatedUnion) {
    return {
      oneOf: getDiscriminatedUnionOptions(current).map((option) => zodToOpenApiSchema(option)),
    };
  }

  if (current instanceof z.ZodIntersection) {
    const { left, right } = getIntersectionParts(current);
    return {
      allOf: [
        zodToOpenApiSchema(left),
        zodToOpenApiSchema(right),
      ],
    };
  }

  return {};
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return true;
  }
  if (schema instanceof z.ZodEffects) {
    return isOptionalSchema(getEffectsSchema(schema));
  }
  return false;
}

function getChecks(schema: z.ZodString | z.ZodNumber): readonly ZodCheck[] {
  return (schema._def as unknown as { readonly checks?: readonly ZodCheck[] }).checks ?? [];
}

function getEffectsSchema(schema: z.ZodEffects<z.ZodTypeAny>): z.ZodTypeAny {
  return (schema._def as unknown as ZodEffectsDef).schema;
}

function getDefaultInnerType(schema: z.ZodDefault<z.ZodTypeAny>): z.ZodTypeAny {
  return (schema._def as unknown as ZodDefaultDef).innerType;
}

function getLiteralValue(schema: z.ZodLiteral<unknown>): unknown {
  return (schema._def as unknown as ZodLiteralDef).value;
}

function getRecordValueType(schema: z.ZodRecord<z.KeySchema>): z.ZodTypeAny {
  return (schema._def as unknown as ZodRecordDef).valueType;
}

function getUnionOptions(schema: z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>): readonly z.ZodTypeAny[] {
  return (schema._def as unknown as ZodUnionDef).options;
}

function getIntersectionParts(schema: z.ZodIntersection<z.ZodTypeAny, z.ZodTypeAny>): ZodIntersectionDef {
  return schema._def as unknown as ZodIntersectionDef;
}

function getDiscriminatedUnionOptions(
  schema: z.ZodDiscriminatedUnion<
    string,
    readonly [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]
  >,
): readonly z.ZodTypeAny[] {
  return (schema._def as unknown as ZodDiscriminatedUnionDef).options;
}

function getObjectEntries(schema: z.ZodObject<z.ZodRawShape>): [string, z.ZodTypeAny][] {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  return Object.entries(shape);
}

function getTupleItems(schema: z.ZodTuple): readonly z.ZodTypeAny[] {
  return (schema._def as unknown as ZodTupleDef).items;
}
