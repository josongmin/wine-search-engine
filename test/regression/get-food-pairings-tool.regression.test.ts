/**
 * Regression suite: `get_food_pairings` agent tool — input → output behavior.
 *
 * Locks down the contract between agent tool input (food, color, price,
 * styles, pairing_tags) and the downstream `searchUseCase.execute` call
 * shape (query string, hybrid mode, structured filters/preferences,
 * structured `food_pairing` output).
 *
 * Maturity 2 → 3 bump: prior coverage in `agent-tools.test.ts` exercises
 * specific axes (budget serialization, color=both, typed objectives). This
 * file pins the END-TO-END tool input/output contract per scenario class
 * (English, Korean, wine-type, price, multi-constraint, validation, no
 * match, determinism, negation, special chars, particles) so that any
 * future change to the tool wiring fails LOUDLY here.
 *
 * Append-only — never delete (CLAUDE.md regression discipline).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAgentTool,
  type AgentToolDeps,
} from '../../src/application/agent/agent-tools.js';
import type { SearchExecutorPort } from '../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

// ---------------------------------------------------------------------------
// Test doubles — mock SearchExecutorPort at the port boundary. NO real LLM,
// NO network. Every test specifies the search response the port returns and
// inspects the request the tool wiring builds.
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
      decisionTraceRef: 'trace-pairing-regression',
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
      requestId: 'req-pairing-regression',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function makeRedWineResult(
  entityId: string,
  label: string,
  wineType: 'red' | 'white' | 'rosé' | 'sparkling' | 'dessert' = 'red',
): SearchResponseV1['results'][number] {
  return {
    entity: {
      entityId,
      canonicalLabel: label,
      type: 'wine',
      wineType,
      style: wineType === 'red' ? 'medium red' : 'crisp white',
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

describe('get_food_pairings tool — input/output regression contract', () => {
  let deps: AgentToolDeps;
  let mockSearchUseCase: SearchExecutorPort;

  beforeEach(() => {
    mockSearchUseCase = { execute: vi.fn() };
    deps = { searchUseCase: mockSearchUseCase };
  });

  // ---------------------------------------------------------------------
  // Core happy paths
  // ---------------------------------------------------------------------

  it('valid English food input ({food: "steak"}) returns pairing wines + structured food_pairing output', async () => {
    const result = makeRedWineResult('cabernet-1', 'Penfolds Bin 389 2018', 'red');
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([result]),
    );

    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: 'steak' },
      deps,
      'req-steak',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('wine pairing for steak');
    expect(request?.options).toEqual({
      mode: 'hybrid',
      explain: false,
      clarification: false,
    });
    // Structured output must be of `food_pairing` kind with food echoed back.
    // The tool returns observation + rawResult; structuredOutput is internal
    // but observable through the rawResult shape (results array) and the
    // pairing context hint inside the observation.
    expect(tool.rawResult).toMatchObject({ queryType: 'search' });
    expect(tool.observation).toContain('PAIRING_CONTEXT');
    expect(tool.observation).toContain('steak');
  });

  it('Korean food input ({food: "스테이크"}) flows through with food preserved verbatim', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([makeRedWineResult('barolo-1', 'Massolino Barolo')]),
    );

    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: '스테이크' },
      deps,
      'req-korean-steak',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('wine pairing for 스테이크');
    // Korean food string must survive without translation/paraphrase.
    expect(tool.observation).toContain('스테이크');
    expect(tool.observation).toContain('PAIRING_CONTEXT');
  });

  // ---------------------------------------------------------------------
  // Constraint forwarding
  // ---------------------------------------------------------------------

  it('color=red constraint adds wine_type filter and excludes other colors via structured filters', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: 'steak', color: 'red' },
      deps,
      'req-red-steak',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
        }),
      ]),
    );
    // No accidental "both" filter
    expect(request?.filters).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'both' }),
      ]),
    );
    // The color is conveyed via the structured filter, NOT appended into the
    // query text — this keeps lexical anchors focused on the food.
    expect(request?.query).toContain('wine pairing for steak');
  });

  it('max_price_krw constraint serializes into KRW clause on the query string', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: 'pizza', max_price_krw: 50_000 },
      deps,
      'req-pizza-budget',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('50000원 이하');
    // Must NOT be locale-formatted (CLAUDE.md rule 21).
    expect(request?.query).not.toContain('50,000');
    expect(request?.query).not.toContain('50.000');
  });

  it('multi-constraint (food + color + price + styles + pairing_tags) forwards every axis', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      {
        food: 'pasta carbonara',
        color: 'white',
        max_price_krw: 80_000,
        styles: ['crisp', 'mineral'],
        pairing_tags: ['pasta'],
        acidity_min: 6,
      },
      deps,
      'req-multi',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('wine pairing for pasta carbonara');
    expect(request?.query).toContain('80000원 이하');
    // Color travels through structured filters, not query text.
    expect(request?.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'wine_type', value: 'white' }),
      ]),
    );
    expect(request?.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attribute: 'pairing',
          operator: 'in',
          value: ['pasta'],
        }),
        expect.objectContaining({
          attribute: 'acidity',
          operator: '>=',
          value: 6,
        }),
      ]),
    );
  });

  // ---------------------------------------------------------------------
  // Zod schema validation — fail-closed branches
  // ---------------------------------------------------------------------

  it('empty food string is rejected by Zod with INVALID_INPUT (observation surfaces error, rawResult is null)', async () => {
    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: '' },
      deps,
      'req-empty',
    );
    expect(tool.observation).toContain('Invalid input for get_food_pairings');
    expect(tool.rawResult).toBeNull();
    // searchUseCase must NOT be called when validation fails.
    expect(vi.mocked(mockSearchUseCase.execute)).not.toHaveBeenCalled();
  });

  it('oversized food string (>200 chars) is rejected by Zod', async () => {
    const oversized = 'a'.repeat(250);
    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: oversized },
      deps,
      'req-oversized',
    );
    expect(tool.observation).toContain('Invalid input for get_food_pairings');
    expect(tool.rawResult).toBeNull();
    expect(vi.mocked(mockSearchUseCase.execute)).not.toHaveBeenCalled();
  });

  it('food string at exactly 200 chars is accepted (boundary inside)', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );
    const exactly200 = 'a'.repeat(200);
    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: exactly200 },
      deps,
      'req-boundary',
    );
    expect(tool.rawResult).not.toBeNull();
    expect(vi.mocked(mockSearchUseCase.execute)).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Pairing extractor (Wave 1) — negation
  // ---------------------------------------------------------------------

  it('food text with English negation ("wine without seafood") is forwarded; downstream extractor handles exclusion', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: 'wine without seafood' },
      deps,
      'req-neg-en',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    // The food string must be forwarded verbatim into the query — the pairing
    // extractor downstream is responsible for negation scope handling.
    expect(request?.query).toContain('wine pairing for wine without seafood');
  });

  it('food text with Korean negation ("새우 빼고") is forwarded verbatim', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: '파스타 새우 빼고' },
      deps,
      'req-neg-ko',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('파스타 새우 빼고');
  });

  // ---------------------------------------------------------------------
  // Graceful empty-result path
  // ---------------------------------------------------------------------

  it('extreme/obscure food (no match → empty results) returns graceful empty list, never throws', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    const tool = await executeAgentTool(
      'get_food_pairings',
      { food: 'fermented unicorn horn shavings' },
      deps,
      'req-obscure',
    );

    expect(tool.rawResult).toMatchObject({ queryType: 'search', results: [] });
    expect(tool.observation).toContain('PAIRING_CONTEXT');
    // Even with zero results, the tool returns a usable observation rather
    // than throwing — orchestrator depends on this contract.
    expect(typeof tool.observation).toBe('string');
    expect(tool.observation.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // Adjacent regressions (CLAUDE.md test discipline §4)
  // ---------------------------------------------------------------------

  it('determinism: 5 identical invocations produce identical request shapes (no hidden randomness)', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    for (let i = 0; i < 5; i += 1) {
      await executeAgentTool(
        'get_food_pairings',
        { food: 'steak', color: 'red', max_price_krw: 60_000 },
        deps,
        'req-det',
      );
    }

    const calls = vi.mocked(mockSearchUseCase.execute).mock.calls;
    expect(calls).toHaveLength(5);
    const first = calls[0]?.[0];
    for (const [request] of calls) {
      expect(request?.query).toBe(first?.query);
      expect(request?.filters).toEqual(first?.filters);
      expect(request?.preferences).toEqual(first?.preferences);
      expect(request?.options).toEqual(first?.options);
    }
  });

  it('special characters in food name (apostrophes, accents) preserved into request query', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: "boeuf bourguignon à l'ancienne" },
      deps,
      'req-special',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain("boeuf bourguignon à l'ancienne");
    // Critical: é/à/' must not have been mangled.
    expect(request?.query).toContain('à');
    expect(request?.query).toContain("'");
  });

  it('Korean particle in food string ("스테이크와 어울리는") forwarded; Korean characters preserved (rule 5)', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      { food: '스테이크와 어울리는' },
      deps,
      'req-particle',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('스테이크와 어울리는');
    // Spot-check: Korean syllables must not have been ASCII-stripped or
    // word-boundary-mangled (CLAUDE.md rules 5, 8).
    expect(request?.query).toMatch(/스테이크/u);
    expect(request?.query).toMatch(/어울리는/u);
  });
});
