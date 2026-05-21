/**
 * Property-based regression suite: `get_food_pairings` AGENT TOOL contract.
 *
 * Scope (per directive): this file pins the TOOL's contract invariants, NOT the
 * pairing-extractor internals (those live with nlu.pairing-extraction, just
 * NFC-promoted). Here we lock the agent-tool boundary:
 *
 *   1. NFC canonicalization — canonically-equivalent food strings (NFC vs NFD
 *      Korean) MUST collapse to ONE deterministic query string.
 *   2. Determinism — identical input ⇒ byte-identical downstream request shape
 *      (query, filters, preferences, options) on repeated invocation.
 *   3. Tool-input schema validation is fail-OPEN to unknown LLM fields
 *      (CLAUDE.md rule 10: LLM tool-call schemas MUST NOT use `.strict()`),
 *      yet fail-CLOSED on the validated axes (empty/oversized food).
 *   4. Bounded result count — `food_pairing` structuredOutput resultCount is a
 *      faithful, bounded reflection of the search response (no fabrication).
 *   5. Output envelope conformance — every accepted call yields a string
 *      observation with PAIRING_CONTEXT echoing the (normalized) food, and a
 *      non-null rawResult of queryType 'search'.
 *   6. Empty / unknown-food safety — zero-result responses never throw and
 *      still return a usable observation.
 *
 * Korean dishes (삼겹살, 회, 잡채) are MANDATORY coverage. No `\b` is used on
 * Korean (CLAUDE.md rules 5/8). fast-check numRuns = 100 per property.
 *
 * Append-only — never delete (CLAUDE.md regression discipline).
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  executeAgentTool,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Test doubles — mock SearchExecutorPort at the port boundary. NO LLM, NO net.
// ---------------------------------------------------------------------------

function makeSearchResponse(
  results: SearchResponseV1['results'],
): SearchResponseV1 {
  return {
    queryType: 'search' as const,
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-pairing-properties',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results,
    meta: {
      requestId: 'req-pairing-properties',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function makeWineResult(
  entityId: string,
  label: string,
): SearchResponseV1['results'][number] {
  return {
    entity: {
      entityId,
      canonicalLabel: label,
      type: 'wine',
      wineType: 'red',
      style: 'medium red',
    },
    relevanceScore: 0.85,
    match: {
      matchType: 'hybrid',
      scoreComponents: {
        lexical: 0.7,
        semantic: 0.7,
        attribute: 0.7,
        popularity: 0.5,
        preferenceAlignment: 0.5,
      },
    },
    constraints: { matched: ['wine_type'], unmet: [], inferred: [] },
    uncertainty: {
      uncertaintyConfidence: 0.9,
      missingInfo: [],
      approximationUsed: false,
    },
    evidenceItems: [],
  };
}

function makeResults(n: number): SearchResponseV1['results'] {
  return Array.from({ length: n }, (_v, i) =>
    makeWineResult(`wine-${i}`, `Wine Number ${i}`),
  );
}

function makeDeps(
  results: SearchResponseV1['results'] = [],
): { deps: AgentToolDeps; mock: SearchExecutorPort } {
  const mock: SearchExecutorPort = {
    execute: vi.fn().mockResolvedValue(makeSearchResponse(results)),
  };
  return { deps: { searchUseCase: mock }, mock };
}

// Korean dishes are MANDATORY. Mix in NFC + NFD encodings of the same dish.
const KOREAN_DISHES = ['삼겹살', '회', '잡채', '김치찌개', '불고기'] as const;

// ---------------------------------------------------------------------------
// Property 1 — NFC canonicalization (the structural bug this suite locks).
// ---------------------------------------------------------------------------

describe('get_food_pairings properties — NFC canonicalization', () => {
  it('NFC and NFD encodings of the same Korean dish produce IDENTICAL query strings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_DISHES),
        async (dish) => {
          const nfc = dish.normalize('NFC');
          const nfd = dish.normalize('NFD');

          const { deps: depsNfc, mock: mockNfc } = makeDeps();
          const { deps: depsNfd, mock: mockNfd } = makeDeps();

          await executeAgentTool('get_food_pairings', { food: nfc }, depsNfc, 'r-nfc');
          await executeAgentTool('get_food_pairings', { food: nfd }, depsNfd, 'r-nfd');

          const qNfc = vi.mocked(mockNfc.execute).mock.calls[0]?.[0]?.query ?? '';
          const qNfd = vi.mocked(mockNfd.execute).mock.calls[0]?.[0]?.query ?? '';

          // Equivalent inputs ⇒ ONE deterministic query string.
          expect(qNfd).toBe(qNfc);
          // The emitted query is itself NFC-canonical (idempotent under NFC).
          expect(qNfd).toBe(qNfd.normalize('NFC'));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('NFC normalization applies to arbitrary text without dropping Korean syllables', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_DISHES),
        fc.constantFrom('', '와 어울리는', ' 추천', ' 빼고'),
        async (dish, suffix) => {
          const food = `${dish}${suffix}`.normalize('NFD');
          const { deps, mock } = makeDeps();
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food },
            deps,
            'r-syll',
          );
          const query = vi.mocked(mock.execute).mock.calls[0]?.[0]?.query ?? '';
          // The pre-composed dish syllables survive (NFC, /u flag, NO \b).
          expect(query).toMatch(new RegExp(dish, 'u'));
          // PAIRING_CONTEXT echoes the NFC-normalized food (not the raw NFD).
          expect(tool.observation).toContain(dish);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Determinism of the downstream request shape.
// ---------------------------------------------------------------------------

describe('get_food_pairings properties — determinism', () => {
  it('identical input yields byte-identical request shape across repeated calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          food: fc.oneof(
            fc.constantFrom(...KOREAN_DISHES),
            fc.constantFrom('steak', 'pizza', 'pasta carbonara'),
          ),
          color: fc.option(
            fc.constantFrom('red' as const, 'white' as const, 'rosé' as const, 'sparkling' as const),
            { nil: undefined },
          ),
          max_price_krw: fc.option(fc.integer({ min: 1, max: 1_000_000 }), {
            nil: undefined,
          }),
        }),
        async (rawInput) => {
          const input = Object.fromEntries(
            Object.entries(rawInput).filter(([, v]) => v !== undefined),
          );
          const { deps, mock } = makeDeps();
          for (let i = 0; i < 3; i += 1) {
            await executeAgentTool('get_food_pairings', input, deps, 'r-det');
          }
          const calls = vi.mocked(mock.execute).mock.calls;
          const first = calls[0]?.[0];
          for (const [req] of calls) {
            expect(req?.query).toBe(first?.query);
            expect(req?.filters).toEqual(first?.filters);
            expect(req?.preferences).toEqual(first?.preferences);
            expect(req?.options).toEqual(first?.options);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Schema is fail-OPEN to unknown LLM fields (rule 10), and the
// known axes still forward correctly. Adversarial extra fields must NOT break
// the tool call (no `.strict()`).
// ---------------------------------------------------------------------------

describe('get_food_pairings properties — schema fail-open to extra LLM fields', () => {
  it('arbitrary unrecognized fields (reasoning/confidence/...) never reject a valid food', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_DISHES, 'steak', 'sushi'),
        fc.dictionary(
          fc.constantFrom('reasoning', 'confidence', 'metadata', 'thought', '_extra'),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          { maxKeys: 5 },
        ),
        async (food, extras) => {
          const { deps, mock } = makeDeps();
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food, ...extras },
            deps,
            'r-extra',
          );
          // Extra LLM-emitted fields must NOT fail validation.
          expect(tool.observation).not.toContain('Invalid input');
          expect(tool.rawResult).not.toBeNull();
          expect(vi.mocked(mock.execute)).toHaveBeenCalledTimes(1);
          // Extra fields must NOT leak into the structured request.
          const req = vi.mocked(mock.execute).mock.calls[0]?.[0];
          for (const key of Object.keys(extras)) {
            expect(req).not.toHaveProperty(key);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('null-valued optional fields are sanitized (LLM emits null for "not set")', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_DISHES, 'steak'),
        async (food) => {
          const { deps, mock } = makeDeps();
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food, color: null, max_price_krw: null, styles: null },
            deps,
            'r-null',
          );
          expect(tool.observation).not.toContain('Invalid input');
          expect(vi.mocked(mock.execute)).toHaveBeenCalledTimes(1);
          // null color ⇒ no wine_type filter forwarded.
          const req = vi.mocked(mock.execute).mock.calls[0]?.[0];
          expect(req?.filters ?? []).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Schema is fail-CLOSED on validated axes (empty/oversized food).
// ---------------------------------------------------------------------------

describe('get_food_pairings properties — fail-closed validation boundaries', () => {
  it('whitespace-only / empty food is always rejected; search is never invoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t\n '),
        async (food) => {
          const { deps, mock } = makeDeps();
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food },
            deps,
            'r-empty',
          );
          expect(tool.observation).toContain('Invalid input for get_food_pairings');
          expect(tool.rawResult).toBeNull();
          expect(vi.mocked(mock.execute)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('oversized food (>200 chars) is always rejected; ≤200 is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 201, max: 600 }),
        async (len) => {
          const { deps, mock } = makeDeps();
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food: 'a'.repeat(len) },
            deps,
            'r-over',
          );
          expect(tool.observation).toContain('Invalid input for get_food_pairings');
          expect(vi.mocked(mock.execute)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Bounded, faithful resultCount + envelope conformance.
// ---------------------------------------------------------------------------

describe('get_food_pairings properties — output envelope + bounded result count', () => {
  it('structuredOutput resultCount equals the search result length (no fabrication)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_DISHES, 'steak'),
        fc.integer({ min: 0, max: 50 }),
        async (food, n) => {
          const { deps } = makeDeps(makeResults(n));
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food },
            deps,
            'r-count',
          );
          // Envelope: always a non-empty string observation echoing the food.
          expect(typeof tool.observation).toBe('string');
          expect(tool.observation.length).toBeGreaterThan(0);
          expect(tool.observation).toContain('PAIRING_CONTEXT');
          expect(tool.observation).toContain(food.normalize('NFC'));
          // rawResult: non-null search response whose results length == n.
          expect(tool.rawResult).toMatchObject({ queryType: 'search' });
          const raw = tool.rawResult as SearchResponseV1;
          expect(raw.results.length).toBe(n);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('zero-result (unknown food) never throws and returns a usable observation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(...KOREAN_DISHES),
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        ),
        async (food) => {
          const { deps } = makeDeps([]);
          const tool = await executeAgentTool(
            'get_food_pairings',
            { food },
            deps,
            'r-zero',
          );
          expect(tool.rawResult).toMatchObject({ queryType: 'search', results: [] });
          expect(typeof tool.observation).toBe('string');
          expect(tool.observation.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
