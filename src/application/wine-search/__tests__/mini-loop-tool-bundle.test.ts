/**
 * MiniLoopToolBundle — unit tests.
 *
 * Verifies the production tool-bundle contract:
 *  - Bundle exposes exactly four tools (one per `KNOWN_AGENT_TOOL_NAMES`).
 *  - Tool names match the SSoT enum EXACTLY (string equality, not just type).
 *  - `inputSchema` is a Zod schema (instanceof `ZodType`).
 *  - Each schema accepts the minimal required input plus Korean strings.
 *  - Each schema is permissive — extra LLM-emitted keys (e.g. `_reasoning`,
 *    `confidence`) do NOT cause `safeParse` to fail (CLAUDE.md rule 10).
 *  - Tool defs have stable referential identity across calls (rule 16 +
 *    prompt-cache hygiene).
 *  - The `toolPorts` identity passes through unchanged.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KNOWN_AGENT_TOOL_NAMES } from '@domain/agent/model/agent-tool-attempt-schema.js';
import type { MiniLoopToolPorts } from '../mini-loop-schemas.js';
import {
  buildMiniLoopToolBundle,
  COMPARE_WINES_TOOL_DEF,
  MINI_LOOP_TOOL_NAMES,
  SEARCH_WINES_TOOL_DEF,
} from '../mini-loop-tool-bundle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub ports — identity matters more than behaviour for these tests. The
 *  mini-loop dispatcher invokes these only at runtime, not at bundle build
 *  time. */
function makeStubToolPorts(): MiniLoopToolPorts {
  return {
    searchUseCase: { execute: async () => { throw new Error('unused in test'); } },
    comparisonUseCase: { execute: async () => { throw new Error('unused in test'); } },
  } as MiniLoopToolPorts;
}

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

describe('buildMiniLoopToolBundle', () => {
  it('returns one tool definition per KNOWN_AGENT_TOOL_NAMES', () => {
    const bundle = buildMiniLoopToolBundle(makeStubToolPorts());
    expect(bundle.tools).toHaveLength(KNOWN_AGENT_TOOL_NAMES.length);
    expect(bundle.tools).toHaveLength(5);
  });

  it('preserves the toolPorts identity (no cloning)', () => {
    const ports = makeStubToolPorts();
    const bundle = buildMiniLoopToolBundle(ports);
    expect(bundle.toolPorts).toBe(ports);
  });

  it('returns identical tool-def identity across calls (prompt-cache hygiene)', () => {
    const a = buildMiniLoopToolBundle(makeStubToolPorts());
    const b = buildMiniLoopToolBundle(makeStubToolPorts());
    expect(a.tools).toBe(b.tools); // same frozen module const
    expect(a.tools[0]).toBe(b.tools[0]); // same per-tool const
  });

  it('exposes tool names that exactly match KNOWN_AGENT_TOOL_NAMES', () => {
    const bundle = buildMiniLoopToolBundle(makeStubToolPorts());
    const names = bundle.tools.map((t) => t.name).sort();
    const expected = [...KNOWN_AGENT_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it('MINI_LOOP_TOOL_NAMES matches the SSoT enum content', () => {
    const sortedBundle = [...MINI_LOOP_TOOL_NAMES].sort();
    const sortedSsot = [...KNOWN_AGENT_TOOL_NAMES].sort();
    expect(sortedBundle).toEqual(sortedSsot);
  });
});

// ---------------------------------------------------------------------------
// Individual tool defs — schemas, descriptions, required fields
// ---------------------------------------------------------------------------

describe('SEARCH_WINES_TOOL_DEF', () => {
  it('has name "search_wines" and a Zod inputSchema', () => {
    expect(SEARCH_WINES_TOOL_DEF.name).toBe('search_wines');
    expect(SEARCH_WINES_TOOL_DEF.inputSchema).toBeInstanceOf(z.ZodType);
    expect(SEARCH_WINES_TOOL_DEF.description.length).toBeGreaterThan(10);
  });

  it('accepts a Korean (한글) query string', () => {
    const parsed = SEARCH_WINES_TOOL_DEF.inputSchema.safeParse({
      query: '부르고뉴 피노누아',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an ASCII query string', () => {
    const parsed = SEARCH_WINES_TOOL_DEF.inputSchema.safeParse({
      query: 'Bordeaux red 2018 under 100k krw',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty query', () => {
    const parsed = SEARCH_WINES_TOOL_DEF.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('requires the query field (no implicit defaulting)', () => {
    const parsed = SEARCH_WINES_TOOL_DEF.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('is permissive — extra LLM-emitted keys do NOT cause failure (rule 10)', () => {
    const parsed = SEARCH_WINES_TOOL_DEF.inputSchema.safeParse({
      query: 'pinot noir',
      _reasoning: 'I picked this because the user asked for red',
      confidence: 0.92,
      metadata: { source: 'llm' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('COMPARE_WINES_TOOL_DEF', () => {
  it('has name "compare_wines" and a Zod inputSchema', () => {
    expect(COMPARE_WINES_TOOL_DEF.name).toBe('compare_wines');
    expect(COMPARE_WINES_TOOL_DEF.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it('requires both query_a AND query_b', () => {
    expect(
      COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({ query_a: 'A', query_b: 'B' }).success,
    ).toBe(true);
    expect(
      COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({ query_a: 'A' }).success,
    ).toBe(false);
    expect(
      COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({ query_b: 'B' }).success,
    ).toBe(false);
    expect(
      COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({}).success,
    ).toBe(false);
  });

  it('accepts Korean queries on both sides', () => {
    const parsed = COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({
      query_a: '샤또 마고 2015',
      query_b: '오퍼스 원 2018',
    });
    expect(parsed.success).toBe(true);
  });

  it('is permissive — extra LLM-emitted keys ignored (rule 10)', () => {
    const parsed = COMPARE_WINES_TOOL_DEF.inputSchema.safeParse({
      query_a: 'wine 1',
      query_b: 'wine 2',
      _reasoning: 'side-by-side flavor profile',
      stopReason: 'tool_use',
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: no .strict() anywhere on the input schemas (rule 10)
// ---------------------------------------------------------------------------

describe('CLAUDE.md rule 10 — LLM tool input schemas MUST NOT be strict', () => {
  it.each([
    ['search_wines', SEARCH_WINES_TOOL_DEF, { query: 'q' }],
    ['compare_wines', COMPARE_WINES_TOOL_DEF, { query_a: 'a', query_b: 'b' }],
  ])('%s schema accepts a payload with an extra unknown key', (_name, def, baseInput) => {
    const parsed = def.inputSchema.safeParse({
      ...baseInput,
      __extraneous_llm_key: 'reasoning text',
    });
    expect(parsed.success).toBe(true);
  });
});
