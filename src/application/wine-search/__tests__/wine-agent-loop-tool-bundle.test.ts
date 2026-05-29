/**
 * WineAgentLoopToolBundle — unit tests.
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
 *
 * T-IR-05 taxonomy: the active loop is exactly the four retrieval primitives
 * (`search_hybrid`, `search_semantic`, `search_lexical`, `lookup_wine`). The
 * three discovery primitives share ONE permissive input schema
 * (`SEARCH_PRIMITIVE_INPUT_SCHEMA`); the retrieval lane is selected by the tool
 * NAME, so there is no `mode` field in the body. The legacy convenience tools
 * (`search_wines`, `get_food_pairings`, `check_drinking_window`,
 * `compare_wines`) were removed from the loop.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KNOWN_AGENT_TOOL_NAMES } from '@domain/agent/model/agent-tool-attempt-schema.js';
import type { WineAgentLoopToolPorts } from '../wine-agent-loop-schemas.js';
import {
  buildWineAgentLoopToolBundle,
  LOOKUP_WINE_TOOL_DEF,
  WINE_AGENT_LOOP_TOOL_NAMES,
  SEARCH_HYBRID_TOOL_DEF,
  SEARCH_SEMANTIC_TOOL_DEF,
  SEARCH_LEXICAL_TOOL_DEF,
} from '../wine-agent-loop-tool-bundle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub ports — identity matters more than behaviour for these tests. The
 *  wine-agent-loop dispatcher invokes these only at runtime, not at bundle build
 *  time. */
function makeStubToolPorts(): WineAgentLoopToolPorts {
  return {
    searchUseCase: { execute: async () => { throw new Error('unused in test'); } },
  } as WineAgentLoopToolPorts;
}

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

describe('buildWineAgentLoopToolBundle', () => {
  it('returns one tool definition per KNOWN_AGENT_TOOL_NAMES', () => {
    const bundle = buildWineAgentLoopToolBundle(makeStubToolPorts());
    expect(bundle.tools).toHaveLength(KNOWN_AGENT_TOOL_NAMES.length);
    expect(bundle.tools).toHaveLength(4);
  });

  it('preserves the toolPorts identity (no cloning)', () => {
    const ports = makeStubToolPorts();
    const bundle = buildWineAgentLoopToolBundle(ports);
    expect(bundle.toolPorts).toBe(ports);
  });

  it('returns identical tool-def identity across calls (prompt-cache hygiene)', () => {
    const a = buildWineAgentLoopToolBundle(makeStubToolPorts());
    const b = buildWineAgentLoopToolBundle(makeStubToolPorts());
    expect(a.tools).toBe(b.tools); // same frozen module const
    expect(a.tools[0]).toBe(b.tools[0]); // same per-tool const
  });

  it('exposes tool names that exactly match KNOWN_AGENT_TOOL_NAMES', () => {
    const bundle = buildWineAgentLoopToolBundle(makeStubToolPorts());
    const names = bundle.tools.map((t) => t.name).sort();
    const expected = [...KNOWN_AGENT_TOOL_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it('WINE_AGENT_LOOP_TOOL_NAMES matches the SSoT enum content', () => {
    const sortedBundle = [...WINE_AGENT_LOOP_TOOL_NAMES].sort();
    const sortedSsot = [...KNOWN_AGENT_TOOL_NAMES].sort();
    expect(sortedBundle).toEqual(sortedSsot);
  });
});

// ---------------------------------------------------------------------------
// Individual tool defs — schemas, descriptions, required fields
//
// T-IR-05: `search_hybrid` is the DEFAULT discovery primitive (replacing the
// removed `search_wines`). It shares `SEARCH_PRIMITIVE_INPUT_SCHEMA` with the
// other two discovery primitives — the schema body is lane-free (no `mode`).
// ---------------------------------------------------------------------------

describe('SEARCH_HYBRID_TOOL_DEF', () => {
  it('has name "search_hybrid" and a Zod inputSchema', () => {
    expect(SEARCH_HYBRID_TOOL_DEF.name).toBe('search_hybrid');
    expect(SEARCH_HYBRID_TOOL_DEF.inputSchema).toBeInstanceOf(z.ZodType);
    expect(SEARCH_HYBRID_TOOL_DEF.description.length).toBeGreaterThan(10);
  });

  it('accepts a Korean (한글) query string', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({
      query: '부르고뉴 피노누아',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an ASCII query string', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({
      query: 'Bordeaux red 2018 under 100k krw',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts structured search fields used by the agent-tools path', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({
      query: 'gift wine',
      wine_type: 'white',
      country: 'France',
      max_alcohol_pct: 12,
      occasion: ['gift'],
      styles: ['approachable', 'presentation_forward'],
      vintage_min: 2020,
      vintage_max: 2022,
      retrieval_mode: 'hybrid',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty query', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('requires the query field (no implicit defaulting)', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('is permissive — extra LLM-emitted keys do NOT cause failure (rule 10)', () => {
    const parsed = SEARCH_HYBRID_TOOL_DEF.inputSchema.safeParse({
      query: 'pinot noir',
      _reasoning: 'I picked this because the user asked for red',
      confidence: 0.92,
      metadata: { source: 'llm' },
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: no .strict() anywhere on the input schemas (rule 10)
//
// T-IR-05: the active tool surface is exactly these four primitives. The three
// discovery primitives share `SEARCH_PRIMITIVE_INPUT_SCHEMA`; `lookup_wine`
// uses the canonical `LookupWineInputSchema`. The removed convenience tools
// (get_food_pairings / check_drinking_window / compare_wines) are no longer
// part of the bundle, so they drop out of this matrix.
// ---------------------------------------------------------------------------

describe('CLAUDE.md rule 10 — LLM tool input schemas MUST NOT be strict', () => {
  it.each([
    ['search_hybrid', SEARCH_HYBRID_TOOL_DEF, { query: 'q' }],
    ['search_semantic', SEARCH_SEMANTIC_TOOL_DEF, { query: 'q' }],
    ['search_lexical', SEARCH_LEXICAL_TOOL_DEF, { query: 'q' }],
    ['lookup_wine', LOOKUP_WINE_TOOL_DEF, { query: 'Opus One 2018' }],
  ])('%s schema accepts a payload with an extra unknown key', (_name, def, baseInput) => {
    const parsed = def.inputSchema.safeParse({
      ...baseInput,
      __extraneous_llm_key: 'reasoning text',
    });
    expect(parsed.success).toBe(true);
  });
});
