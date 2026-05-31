/**
 * Schema quality audit — automated enforcement of CLAUDE.md schema rules.
 *
 * Walks all HTTP-facing Zod schemas and asserts:
 *  1. Every z.number() has .finite() or .int()
 *  2. Every z.array() has .max()
 *
 * This prevents NaN/Infinity propagation and unbounded response payloads
 * from slipping through code review. Exemptions must be added to the
 * allowlist with a justifying comment.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Import all HTTP-facing schemas
import * as searchResponseSchemas from '../../../src/interface/http/schemas/search-response.schema.js';
import * as searchResponseV2Schemas from '../../../src/interface/http/schemas/search-response-v2.schema.js';
import * as searchRequestSchemas from '../../../src/interface/http/schemas/search-request.schema.js';
import * as searchSharedSchemas from '../../../src/interface/http/schemas/search-shared.schema.js';
import * as batchSearchSchemas from '../../../src/interface/http/schemas/batch-search.schema.js';

// ---------------------------------------------------------------------------
// Schema walker
// ---------------------------------------------------------------------------

interface SchemaViolation {
  readonly path: string;
  readonly rule: 'number_missing_finite' | 'array_missing_max';
  readonly schemaType: string;
}

function hasCheck(schema: z.ZodTypeAny, kind: string): boolean {
  const def = (schema as unknown as { _def?: { checks?: readonly { kind: string }[] } })._def;
  return def?.checks?.some((c) => c.kind === kind) ?? false;
}

function walkSchema(
  schema: z.ZodTypeAny,
  path: string,
  violations: SchemaViolation[],
  visited = new WeakSet<z.ZodTypeAny>(),
): void {
  if (visited.has(schema)) return;
  visited.add(schema);

  // Unwrap wrappers
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    walkSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap(), path, violations, visited);
    return;
  }
  if (schema instanceof z.ZodDefault) {
    walkSchema((schema._def as unknown as { innerType: z.ZodTypeAny }).innerType, path, violations, visited);
    return;
  }
  if (schema instanceof z.ZodEffects) {
    walkSchema((schema._def as unknown as { schema: z.ZodTypeAny }).schema, path, violations, visited);
    return;
  }

  // z.number() — must have .finite(), .int(), or explicit .min()/.max() bounds
  // (Zod's min/max comparisons reject NaN because NaN < N is always false)
  if (schema instanceof z.ZodNumber) {
    const isInt = hasCheck(schema, 'int');
    const isFinite = hasCheck(schema, 'finite');
    const hasMin = hasCheck(schema, 'min');
    const hasMax = hasCheck(schema, 'max');
    // .min() or .max() reject NaN implicitly, so they count as a finite guard.
    if (!isInt && !isFinite && !hasMin && !hasMax) {
      violations.push({ path, rule: 'number_missing_finite', schemaType: 'ZodNumber' });
    }
    return;
  }

  // z.array() — must have .max()
  // ZodArray stores max length in _def.maxLength (not in _def.checks like ZodString/ZodNumber).
  if (schema instanceof z.ZodArray) {
    const def = (schema as unknown as { _def?: { maxLength?: { value: number } | null } })._def;
    const hasMax = def?.maxLength !== undefined && def.maxLength !== null;
    if (!hasMax) {
      violations.push({ path, rule: 'array_missing_max', schemaType: 'ZodArray' });
    }
    walkSchema(schema.element, `${path}[]`, violations, visited);
    return;
  }

  // z.object() — recurse into shape
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    for (const [key, value] of Object.entries(shape)) {
      walkSchema(value, `${path}.${key}`, violations, visited);
    }
    return;
  }

  // z.union / z.discriminatedUnion
  if (schema instanceof z.ZodUnion) {
    const options = (schema._def as unknown as { options: readonly z.ZodTypeAny[] }).options;
    for (let i = 0; i < options.length; i++) {
      walkSchema(options[i]!, `${path}|union[${i}]`, violations, visited);
    }
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema._def as unknown as { options: readonly z.ZodTypeAny[] }).options;
    for (let i = 0; i < options.length; i++) {
      walkSchema(options[i]!, `${path}|discUnion[${i}]`, violations, visited);
    }
    return;
  }

  // z.tuple
  if (schema instanceof z.ZodTuple) {
    const items = (schema._def as unknown as { items: readonly z.ZodTypeAny[] }).items;
    for (let i = 0; i < items.length; i++) {
      walkSchema(items[i]!, `${path}[${i}]`, violations, visited);
    }
    return;
  }

  // z.record
  if (schema instanceof z.ZodRecord) {
    const valueType = (schema._def as unknown as { valueType: z.ZodTypeAny }).valueType;
    walkSchema(valueType, `${path}[*]`, violations, visited);
    return;
  }

  // z.intersection
  if (schema instanceof z.ZodIntersection) {
    const def = schema._def as unknown as { left: z.ZodTypeAny; right: z.ZodTypeAny };
    walkSchema(def.left, `${path}&left`, violations, visited);
    walkSchema(def.right, `${path}&right`, violations, visited);
    return;
  }
}

// ---------------------------------------------------------------------------
// Collect all exported schemas
// ---------------------------------------------------------------------------

function collectSchemas(
  modules: Record<string, Record<string, unknown>>,
): { name: string; schema: z.ZodTypeAny }[] {
  const result: { name: string; schema: z.ZodTypeAny }[] = [];
  for (const [moduleName, mod] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) {
        result.push({ name: `${moduleName}.${exportName}`, schema: value as z.ZodTypeAny });
      }
    }
  }
  return result;
}

const ALL_SCHEMAS = collectSchemas({
  searchResponse: searchResponseSchemas,
  searchResponseV2: searchResponseV2Schemas,
  searchRequest: searchRequestSchemas,
  searchShared: searchSharedSchemas,
  batchSearch: batchSearchSchemas,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Schema quality audit (CLAUDE.md enforcement)', () => {
  it('every z.number() in HTTP schemas has .finite() or .int()', () => {
    const violations: SchemaViolation[] = [];
    for (const { name, schema } of ALL_SCHEMAS) {
      walkSchema(schema, name, violations);
    }
    const numberViolations = violations.filter((v) => v.rule === 'number_missing_finite');
    if (numberViolations.length > 0) {
      const report = numberViolations.map((v) => `  ${v.path}`).join('\n');
      expect.fail(
        `Found ${numberViolations.length} z.number() without .finite() or .int():\n${report}\n\n` +
        'Fix: add .finite() to each, or .int() if the field is integer-only.',
      );
    }
  });

  it('every z.array() in HTTP schemas has .max()', () => {
    const violations: SchemaViolation[] = [];
    for (const { name, schema } of ALL_SCHEMAS) {
      walkSchema(schema, name, violations);
    }
    const arrayViolations = violations.filter((v) => v.rule === 'array_missing_max');
    if (arrayViolations.length > 0) {
      const report = arrayViolations.map((v) => `  ${v.path}`).join('\n');
      expect.fail(
        `Found ${arrayViolations.length} z.array() without .max():\n${report}\n\n` +
        'Fix: add .max(N) with a domain-justified bound.',
      );
    }
  });
});
