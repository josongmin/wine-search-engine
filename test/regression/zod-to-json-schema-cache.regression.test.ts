/**
 * Regression: `zodToJsonSchema` caches by schema identity (F4).
 *
 * Module-scope tool definitions and synthesis schemas are constructed
 * ONCE and reused across every LLM call. Without the WeakMap cache the
 * converter ran for every wine-agent-loop turn × N tools, plus every synthesis
 * request. The cache amortises that cost to one conversion per schema
 * identity for the process lifetime.
 *
 * We pin two contracts:
 *  1. Same schema instance → same JsonSchema (referential identity).
 *  2. Different schema instance with the SAME shape → different JsonSchema
 *     OBJECTS (we cache by identity, not by structure — different schema
 *     instances may have different downstream validation behaviour even
 *     when their JSON-Schema projections look identical).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/infrastructure/ai/claude-structured-llm-adapter.js';

describe('zodToJsonSchema cache (F4 regression)', () => {
  it('returns referentially-identical output on repeat calls with the same schema', () => {
    const schema = z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional(),
    });
    const first = zodToJsonSchema(schema);
    const second = zodToJsonSchema(schema);
    // Reference identity proves the cache is HIT — cheap & deterministic.
    expect(second).toBe(first);
  });

  it('caches distinct schema identities independently', () => {
    const schemaA = z.object({ x: z.string() });
    const schemaB = z.object({ x: z.string() });  // same shape, different instance
    const a = zodToJsonSchema(schemaA);
    const b = zodToJsonSchema(schemaB);
    // Different instances → different cache slots → different objects.
    // (Structurally equivalent, but not referentially shared.)
    expect(a).not.toBe(b);
  });

  it('produces correct JsonSchema for a nested object', () => {
    const schema = z.object({
      query: z.string(),
      filters: z.array(z.string()).optional(),
    });
    const out = zodToJsonSchema(schema);
    expect(out).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters: { type: 'array' },
      },
      required: ['query'],
    });
  });

  it('handles direct recursion call sites (depth>0 must still produce a valid sub-schema)', () => {
    // Outer schema with a nested object — recursive call into the nested
    // shape MUST traverse normally (skip cache at depth>0).
    const inner = z.object({ name: z.string() });
    const outer = z.object({ inner });
    const a = zodToJsonSchema(outer);
    const b = zodToJsonSchema(outer);
    expect(b).toBe(a);
    // Structural sanity: outer projects the inner shape under properties.inner.
    const props = (a as { properties: Record<string, unknown> }).properties;
    expect((props['inner'] as { type?: string })?.type).toBe('object');
  });
});
