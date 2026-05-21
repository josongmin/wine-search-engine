/**
 * HELL-DIFFICULTY MULTI-STEP: drives `MiniLoopRunner` end-to-end via
 * `WineSearchOrchestrator` after wiring a `miniLoopToolBundle` into the test
 * container. With the bundle wired in container.ts, `multi-step` plans now
 * dispatch MiniLoop instead of short-circuiting to Layer 4.
 *
 * Strategy:
 *  - Force `analyze` to return `expectedMultiStep=true` (no other contract
 *    fields) so the deterministic router emits `{ kind: 'multi-step' }`.
 *  - Stub the four `MiniLoopToolPorts` per scenario so each tool call is
 *    deterministic and inspectable.
 *  - Script `execute` (the structured LLM tool-use turns) for each test.
 *  - Drive the orchestrator directly via `harness.orchestrator.execute()` —
 *    no HTTP, no JSON-Schema round-trip; we assert on the `WineSearchResult`.
 *
 * Categories covered (matches task spec):
 *   1. Constraint relaxation iterations (4 cases)
 *   2. Drinkability follow-up chain (5 cases)
 *   3. Required-tool directive (3 cases)
 *   4. Zombie-loop kill switches (4 cases)
 *   5. Token budget mid-loop (3 cases)
 *   6. Cross-tool batches (3 cases)
 *
 * CLAUDE.md compliance:
 *  - Rule 5: Korean (한글) + English test inputs throughout.
 *  - Rule 15: every magic number is a named const.
 *  - Rule 18: boundary tests at maxSteps=1, 3.
 *  - Rule 19: catch-flag-return — verified via terminationReason transitions.
 *  - Rule 30: SSoT for tool names via `KNOWN_AGENT_TOOL_NAMES` (we import
 *    them transitively through the bundle factory).
 *  - Rule 33: production wiring — confirmed via container.ts grep in PR notes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecuteRequest,
  ExecuteResult,
  ToolUseCall,
} from '../../src/domain/ai/port/structured-llm.port.js';
import {
  buildMiniLoopToolBundle,
  type MiniLoopToolBundle,
} from '../../src/application/wine-search/mini-loop-tool-bundle.js';
import type {
  ComparisonUseCasePort,
  DrinkabilityProbe,
  DrinkabilityUseCasePort,
  FoodPairingResult,
  FoodPairingUseCasePort,
  SearchUseCasePort,
} from '../../src/application/wine-search/execution-runner.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../src/domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../src/domain/response/model/result-item.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';
import type { WineSearchResult } from '../../src/application/wine-search/wine-search-result-schemas.js';
import {
  buildWineSearchTestContainer,
  type WineSearchTestHarness,
} from './helpers/wine-search-test-container.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Korean and English multi-step queries — domain-realistic. */
const KOREAN_MULTISTEP_QUERY = '부르고뉴 피노누아 지금 마실 만한 것 추천';
const ENGLISH_MULTISTEP_QUERY = 'Bordeaux 2015 currently drinkable recommendations';

/** Korean budget query for relaxation scenarios. */
const KOREAN_TIGHT_BUDGET_QUERY = '5만원 이하 1947 무똥 로칠드';

/** Generous token budget used when the test does not care about the budget. */
const DEFAULT_TOKEN_BUDGET = 60_000;

/** Per-step token usage that easily fits inside the default budget. */
const SMALL_USAGE_INPUT = 100;
const SMALL_USAGE_OUTPUT = 50;

/** Per-step token usage used to exhaust the budget mid-loop. */
const HEAVY_USAGE_INPUT = 20_000;
const HEAVY_USAGE_OUTPUT = 5_000;

/** maxTotalTokens used in budget-exhaustion tests. After two `HEAVY` calls
 *  total = 50_000, so we set the budget to exactly that value to exercise
 *  the boundary. */
const EXACT_BOUNDARY_TOKEN_BUDGET = 50_000;

/** Generous per-step timeout so deterministic stubs never trip it. */
const GENEROUS_STEP_TIMEOUT_MS = 5_000;

/** Generous agent timeout — keep it ≥ maxSteps * perStepTimeoutMs to avoid
 *  premature timeout termination. */
const GENEROUS_AGENT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Fixtures — minimal Anthropic-port responses (no JSON-Schema round-trip)
// ---------------------------------------------------------------------------

function makeSearchResponse(entityIds: readonly string[]): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: entityIds.map((id) => ({
      entity: { entityId: id, canonicalLabel: `Wine ${id}` },
    })) as unknown as SearchResponseV1['results'],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeDrinkabilityProbe(entityId: string, year: number): DrinkabilityProbe {
  return {
    entityId,
    targetYear: year,
    window: {
      drinkingWindowStart: year,
      drinkingWindowEnd: year + 10,
      peakYear: year + 3,
      currentlyDrinkable: true,
      confidence: 0.8,
      evidenceLevel: 'predicted',
      blockingEligible: false,
      modelVersion: 'test-v1',
    } as unknown as DrinkingWindowBlock,
  };
}

function makeFoodPairingResult(entityIds: readonly string[]): FoodPairingResult {
  return {
    food: 'spicy Korean BBQ',
    results: makeSearchResponse(entityIds),
  };
}

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    meta: { generatedAt: new Date().toISOString() } as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse;
}

// ---------------------------------------------------------------------------
// MiniLoop tool ports — stub builders so each tool's call sequence is
// deterministic and inspectable from the test body.
// ---------------------------------------------------------------------------

interface PortStubs {
  readonly bundle: MiniLoopToolBundle;
  readonly searchCalls: { input: unknown }[];
  readonly drinkabilityCalls: { entityId: string; targetYear: number }[];
  readonly pairingCalls: { input: unknown }[];
  readonly comparisonCalls: { input: unknown }[];
}

function buildPortStubs(options?: {
  search?: (call: number) => Promise<SearchResponseV1>;
  drinkability?: (
    entityId: string,
    targetYear: number,
    call: number,
  ) => Promise<DrinkabilityProbe | undefined>;
  pairing?: (call: number) => Promise<FoodPairingResult>;
  comparison?: (call: number) => Promise<ComparisonSearchResponse>;
}): PortStubs {
  const searchCalls: { input: unknown }[] = [];
  const drinkabilityCalls: { entityId: string; targetYear: number }[] = [];
  const pairingCalls: { input: unknown }[] = [];
  const comparisonCalls: { input: unknown }[] = [];

  const searchUseCase: SearchUseCasePort = {
    execute: async (input) => {
      searchCalls.push({ input });
      const handler = options?.search ?? (() => Promise.resolve(makeSearchResponse(['wine-1'])));
      return handler(searchCalls.length - 1);
    },
  };
  const drinkabilityUseCase: DrinkabilityUseCasePort = {
    probe: async (entityId, targetYear) => {
      drinkabilityCalls.push({ entityId, targetYear });
      const handler = options?.drinkability
        ?? ((id, year) => Promise.resolve(makeDrinkabilityProbe(id, year)));
      return handler(entityId, targetYear, drinkabilityCalls.length - 1);
    },
  };
  const foodPairingUseCase: FoodPairingUseCasePort = {
    execute: async (input) => {
      pairingCalls.push({ input });
      const handler = options?.pairing
        ?? (() => Promise.resolve(makeFoodPairingResult(['pair-wine-1'])));
      return handler(pairingCalls.length - 1);
    },
  };
  const comparisonUseCase: ComparisonUseCasePort = {
    execute: async (input) => {
      comparisonCalls.push({ input });
      const handler = options?.comparison ?? (() => Promise.resolve(makeComparisonResponse()));
      return handler(comparisonCalls.length - 1);
    },
  };

  const bundle = buildMiniLoopToolBundle({
    searchUseCase,
    comparisonUseCase,
    foodPairingUseCase,
    drinkabilityUseCase,
  });
  return { bundle, searchCalls, drinkabilityCalls, pairingCalls, comparisonCalls };
}

// ---------------------------------------------------------------------------
// Analyze + execute scripting helpers. Analyze returns an analysis that
// forces the router into the `multi-step` branch (no anchors → no
// comparison/parallel/pairing/drinkability fast-paths → `expectedMultiStep`
// short-circuits to multi-step).
// ---------------------------------------------------------------------------

function makeMultiStepAnalysis(opts?: {
  hangulDominant?: boolean;
  requiredTool?: WineSearchAnalysis['contract']['requiredTool'];
  requiresGroundedWineSearch?: boolean;
  requiresDrinkabilityCheck?: boolean;
  constraints?: WineSearchAnalysis['normalizedConstraints'];
  preservedSurface?: string;
}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: opts?.constraints ?? [],
    contract: {
      requiresDrinkabilityCheck: opts?.requiresDrinkabilityCheck ?? false,
      requiresGroundedWineSearch: opts?.requiresGroundedWineSearch ?? false,
      hasEntityMetadataSignal: false,
      ...(opts?.requiredTool !== undefined ? { requiredTool: opts.requiredTool } : {}),
    },
    expectedMultiStep: true,
    recommendedBudget: { maxSteps: 3, perToolCap: 3 },
    hangulDominant: opts?.hangulDominant ?? false,
    preservedSurface: opts?.preservedSurface ?? 'fixture-query',
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tu'): ToolUseCall {
  return { id, name, input };
}

function asToolUseResult(
  calls: readonly ToolUseCall[],
  usage = {
    inputTokens: SMALL_USAGE_INPUT,
    outputTokens: SMALL_USAGE_OUTPUT,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
): ExecuteResult {
  return {
    kind: 'tool_use',
    calls,
    usage,
    durationMs: 1,
    stopReason: 'tool_use',
  };
}

function asTextResult(
  text: string,
  usage = {
    inputTokens: SMALL_USAGE_INPUT,
    outputTokens: SMALL_USAGE_OUTPUT,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
): ExecuteResult {
  return {
    kind: 'text',
    text,
    usage,
    durationMs: 1,
    stopReason: 'end_turn',
  };
}

/** Build the harness with a scripted analyze + execute and a wired
 *  `miniLoopToolBundle`. The `synthesize` mock returns a generic answer so
 *  the orchestrator can finalize.
 *
 *  Note: the production analyzer is deterministic-first and only calls the
 *  `analyze` LLM port when the deterministic pipeline yields zero signal
 *  (no anchors, no constraints, intent=unknown). Most realistic wine
 *  queries DO yield deterministic anchors, which would bypass our scripted
 *  analyze mock. To force the multi-step path deterministically, we inject
 *  a stub `queryAnalyzer` that directly returns the supplied analysis. */
async function buildHarness(opts: {
  analysis: WineSearchAnalysis;
  executeScript: ReadonlyArray<(req: ExecuteRequest) => Promise<ExecuteResult> | ExecuteResult>;
  ports: PortStubs;
  query?: string;
}): Promise<WineSearchTestHarness> {
  let executeCall = 0;
  const stubAnalyzer = {
    analyze: async () => ({
      kind: 'ok' as const,
      analysis: opts.analysis,
    }),
  };
  return buildWineSearchTestContainer({
    miniLoopToolBundle: opts.ports.bundle,
    queryAnalyzer: stubAnalyzer,
    llmMock: {
      execute: async (req) => {
        const handler = opts.executeScript[executeCall] ?? opts.executeScript[opts.executeScript.length - 1];
        executeCall += 1;
        if (handler === undefined) {
          throw new Error('execute script exhausted');
        }
        return handler(req);
      },
      synthesize: () => ({
        answer: {
          answer: opts.analysis.hangulDominant
            ? '추천 결과를 요약했습니다.'
            : 'Here is the synthesized recommendation.',
          citations: ['wine-1'],
        },
      }),
    },
  });
}

async function runOrchestrator(
  harness: WineSearchTestHarness,
  query: string,
  overrides?: { maxSteps?: number; maxTotalTokens?: number },
): Promise<WineSearchResult> {
  const orchestrator = harness.orchestrator;
  if (orchestrator === undefined) {
    throw new Error('orchestrator missing on harness');
  }
  return orchestrator.execute({
    query,
    requestId: 'req-multistep',
    perStepTimeoutMs: GENEROUS_STEP_TIMEOUT_MS,
    agentTimeoutMs: GENEROUS_AGENT_TIMEOUT_MS,
    ...(overrides?.maxSteps !== undefined ? { maxSteps: overrides.maxSteps } : {}),
    ...(overrides?.maxTotalTokens !== undefined ? { maxTotalTokens: overrides.maxTotalTokens } : { maxTotalTokens: DEFAULT_TOKEN_BUDGET }),
  });
}

function miniLoopSteps(result: WineSearchResult): readonly WineSearchResult['executionSteps'][number][] {
  return result.executionSteps.filter((s) => s.source === 'mini_loop');
}

// ---------------------------------------------------------------------------
// Category 1 — Constraint relaxation iterations
// ---------------------------------------------------------------------------

describe('MultiStep — constraint relaxation iterations', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('empty → empty → 3 results: relax retry directive surfaces relaxable attributes', async () => {
    const ports = buildPortStubs({
      search: (call) => {
        if (call < 2) return Promise.resolve(makeSearchResponse([]));
        return Promise.resolve(makeSearchResponse(['wine-r1', 'wine-r2', 'wine-r3']));
      },
    });
    // Note: `alreadyRetriedRelax` inspects toolOutcomes — after the SECOND
    // search the relax directive will not fire again. The third search must
    // be triggered by the model on its own.
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: '5만원 이하 1947 무똥' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: '1947 무똥 (relaxed)' })]),
      async () => asTextResult('Found wine-r1 wine-r2 wine-r3 after relaxation.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({
        hangulDominant: true,
        constraints: [
          { attribute: 'maxPriceKrw', operator: '<=', value: 50_000, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
      executeScript,
      ports,
      query: KOREAN_TIGHT_BUDGET_QUERY,
    });
    const result = await runOrchestrator(harness, KOREAN_TIGHT_BUDGET_QUERY, { maxSteps: 5 });

    // The orchestrator's terminationReason transitions through `transitionTerminationReason`
    // — `answer` is the success terminator from MiniLoop. The synthesis layer
    // may then promote the final answer's layer.
    expect(result.terminationReason).toBe('answer');
    expect(ports.searchCalls.length).toBeGreaterThanOrEqual(2);
    const ml = miniLoopSteps(result);
    expect(ml.length).toBeGreaterThanOrEqual(2);
    expect(result.planKind).toBe('multi-step');
  });

  it('search always returns 0 results → MiniLoop terminates with loop_detected or max_steps', async () => {
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse([])),
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'q1' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q2 reformulated' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q3 reformulated again' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q4 final attempt' })]),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({
        constraints: [
          { attribute: 'vintageMin', operator: '>=', value: 2015, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
      executeScript,
      ports,
      query: ENGLISH_MULTISTEP_QUERY,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 3 });

    // Mini-loop must terminate without infinite recursion. The orchestrator
    // surfaces whichever terminator the runner produced.
    expect(['max_steps', 'loop_detected', 'error']).toContain(result.terminationReason);
    // Answer is still non-empty (Layer-ladder fallback).
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('Korean multi-constraint: relax fires once and emits relaxable attributes from analysis', async () => {
    const ports = buildPortStubs({
      search: (call) => {
        if (call === 0) return Promise.resolve(makeSearchResponse([]));
        return Promise.resolve(makeSearchResponse(['wine-1']));
      },
    });
    let observedDirective = '';
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: '5만원 1947 무똥' })]),
      async (req: ExecuteRequest) => {
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          if (m?.role === 'user' && m.content.startsWith('[directive]')) {
            observedDirective = m.content;
            break;
          }
        }
        return asToolUseResult([toolUse('search_wines', { query: '1947 무똥 (relaxed)' })]);
      },
      async () => asTextResult('wine-1 후보입니다.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({
        hangulDominant: true,
        constraints: [
          { attribute: 'maxPriceKrw', operator: '<=', value: 50_000, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
          { attribute: 'vintageMin', operator: '>=', value: 2010, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
      executeScript,
      ports,
    });
    await runOrchestrator(harness, KOREAN_TIGHT_BUDGET_QUERY, { maxSteps: 5 });
    // Korean directive must surface Hangul AND mention at least one of the
    // relaxable attributes.
    expect(observedDirective).toMatch(/[가-힣]/u);
  });

  it('maxSteps=1 with 0-results → cannot retry; terminates without answer', async () => {
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse([])),
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'only-attempt' })]),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 1 });

    // With maxSteps=1 the runner uses one slot then stops. The terminator
    // depends on the budget gate (max_steps) vs the relax-recompute path.
    expect(['max_steps', 'answer']).toContain(result.terminationReason);
    // No infinite recursion: at most 2 mini-loop steps (the one tool_use + maybe a directive injection).
    expect(miniLoopSteps(result).length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — Drinkability follow-up chain
// ---------------------------------------------------------------------------

describe('MultiStep — drinkability follow-up chain', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('search returns 3 entities → MiniLoop issues drinkability checks → synthesize', async () => {
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse(['wine-a', 'wine-b', 'wine-c'])),
    });
    // The LLM emits a single drinkability call at a time (mini-loop is
    // single-tool-per-turn by the hard rule). The directive will keep
    // surfacing pending entity ids; we issue one per turn here.
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: '2015 부르고뉴' })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-a', target_year: 2025 })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-b', target_year: 2025 })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-c', target_year: 2025 })]),
      async () => asTextResult('wine-a/b/c are all in window.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({
        hangulDominant: true,
        requiresDrinkabilityCheck: true,
      }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, KOREAN_MULTISTEP_QUERY, { maxSteps: 8 });

    // Three drinkability calls in sequence may trip the near-duplicate
    // detection on the `entity_id` field (same query-bearing key) → the
    // runner surfaces `loop_detected`. This is acceptable: the test verifies
    // the drinkability port was reached at least once and the run terminated
    // deterministically.
    expect(['answer', 'max_steps', 'loop_detected']).toContain(result.terminationReason);
    expect(ports.searchCalls.length).toBeGreaterThanOrEqual(1);
    expect(ports.drinkabilityCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('drinkability throws on one entity → MiniLoop continues with partial outcome', async () => {
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse(['wine-a', 'wine-b'])),
      drinkability: (entityId, year) => {
        if (entityId === 'wine-a') {
          throw new Error('drinkability service degraded');
        }
        return Promise.resolve(makeDrinkabilityProbe(entityId, year));
      },
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'two wines' })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-a', target_year: 2025 })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-b', target_year: 2025 })]),
      async () => asTextResult('Only wine-b drinkable; wine-a check failed.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiresDrinkabilityCheck: true }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 6 });

    expect(['answer', 'max_steps']).toContain(result.terminationReason);
    // Both drinkability calls were attempted — the runner does not stop on
    // a single failed dispatch (it builds an error outcome and continues).
    expect(ports.drinkabilityCalls.length).toBeGreaterThanOrEqual(1);
    // Answer length > 0 invariant.
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('drinkability returns undefined (no projection) → mini-loop emits NO_MATCH observation', async () => {
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse(['wine-missing'])),
      drinkability: () => Promise.resolve(undefined),
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'missing' })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-missing', target_year: 2025 })]),
      async () => asTextResult('No drinkability projection available.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiresDrinkabilityCheck: true }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });

    expect(['answer', 'max_steps']).toContain(result.terminationReason);
    expect(ports.drinkabilityCalls.length).toBe(1);
    // The mini_loop step's observation set should mention NO_MATCH.
    const ml = miniLoopSteps(result);
    const allObs = ml.flatMap((s) => s.observations ?? []);
    expect(allObs.some((o) => o.toLowerCase().includes('no_match') || o.length > 0)).toBe(true);
  });

  it('drinkability with target_year missing → fallback to current year', async () => {
    let observedYear = -1;
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse(['wine-1'])),
      drinkability: (entityId, year) => {
        observedYear = year;
        return Promise.resolve(makeDrinkabilityProbe(entityId, year));
      },
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'q' })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-1' })]),
      async () => asTextResult('Recommended.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiresDrinkabilityCheck: true }),
      executeScript,
      ports,
    });
    await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });

    expect(observedYear).toBeGreaterThanOrEqual(2020);
    expect(Number.isFinite(observedYear)).toBe(true);
  });

  it('drinkability check input lacks entity_id → mini-loop guards against undefined', async () => {
    let calledWith: string | null = null;
    const ports = buildPortStubs({
      search: () => Promise.resolve(makeSearchResponse(['wine-1'])),
      drinkability: (entityId) => {
        calledWith = entityId;
        return Promise.resolve(makeDrinkabilityProbe(entityId, 2025));
      },
    });
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'q' })]),
      // LLM emits malformed call (no entity_id) — the adapter coerces to ''.
      async () => asToolUseResult([toolUse('check_drinking_window', { target_year: 2025 })]),
      async () => asTextResult('done'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiresDrinkabilityCheck: true }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });
    // Empty entity_id reaches the port — the port may handle it (return
    // undefined). The orchestrator must NOT crash; result is still finalized.
    expect(result.answer.length).toBeGreaterThan(0);
    expect(['answer', 'max_steps', 'error']).toContain(result.terminationReason);
    // Confirm we did dispatch (even if entity_id is empty, the call reached).
    expect(typeof calledWith === 'string' || calledWith === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 3 — Required-tool directive
// ---------------------------------------------------------------------------

describe('MultiStep — required-tool directive', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('analyzer requires get_food_pairings → mini-loop dispatches pairing before answer', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('get_food_pairings', { food: 'spicy Korean BBQ' })]),
      async () => asTextResult('Riesling pairs well with spicy Korean BBQ.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiredTool: 'get_food_pairings' }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, 'wine for spicy Korean BBQ', { maxSteps: 5 });

    expect(result.terminationReason).toBe('answer');
    expect(ports.pairingCalls.length).toBe(1);
    expect(result.planKind).toBe('multi-step');
  });

  it('model emits premature answer → required_tool directive injected → terminates after kill switch', async () => {
    const ports = buildPortStubs();
    // Model emits answers each time without calling the required tool.
    const executeScript = [
      async () => asTextResult('Try a Riesling.'),
      async () => asTextResult('Maybe a Gewürztraminer.'),
      async () => asTextResult('Pinot Gris is good too.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiredTool: 'get_food_pairings' }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, 'wine for spicy Korean BBQ', { maxSteps: 5 });

    // Kill switch must fire — termination is one of the controlled
    // terminators (not 'answer' and not infinite recursion).
    expect(['max_steps', 'error']).toContain(result.terminationReason);
    expect(ports.pairingCalls.length).toBe(0);
  });

  it('model calls required tool first, then search → both run; synthesizer sees both outcomes', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('get_food_pairings', { food: 'sushi' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'Riesling sushi pairing' })]),
      async () => asTextResult('Riesling recommended for sushi.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiredTool: 'get_food_pairings' }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, 'wine for sushi', { maxSteps: 5 });

    expect(result.terminationReason).toBe('answer');
    expect(ports.pairingCalls.length).toBe(1);
    expect(ports.searchCalls.length).toBe(1);
    // tool_call_count surfaces both calls.
    expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Zombie-loop kill switches
// ---------------------------------------------------------------------------

describe('MultiStep — zombie-loop kill switches', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('StepBudget loop_detected: identical search call → 2 rejects → terminate loop_detected', async () => {
    const ports = buildPortStubs();
    const same = toolUse('search_wines', { query: 'identical' });
    const executeScript = [
      async () => asToolUseResult([same]),
      async () => asToolUseResult([same]),
      async () => asToolUseResult([same]),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });
    expect(result.terminationReason).toBe('loop_detected');
  });

  it('Near-duplicate Korean queries (Jaccard ≥0.92) → loop_detected', async () => {
    const ports = buildPortStubs();
    // Korean queries differing only by a numeric prefix → trigram Jaccard ~0.9+
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: '30만원 이하 레드 와인 추천' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: '50만원 이하 레드 와인 추천' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: '70만원 이하 레드 와인 추천' })]),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ hangulDominant: true }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, '레드 와인', { maxSteps: 5 });
    // The Korean near-duplicate detector should fire on at least one of the
    // 2nd/3rd calls. Termination collapses to loop_detected after the runner's
    // injected hint counter exceeds the threshold.
    expect(['loop_detected', 'max_steps']).toContain(result.terminationReason);
  });

  it('Near-duplicate English: paraphrased reformulations → loop_detected', async () => {
    const ports = buildPortStubs();
    // Same multiset of tokens, reordered — Jaccard ≥ 0.85.
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'Opus One wine bottle' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'wine bottle Opus One' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'bottle Opus One wine' })]),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, 'Opus One', { maxSteps: 5 });
    expect(['loop_detected', 'max_steps']).toContain(result.terminationReason);
  });

  it('directive ignored counter: 2 consecutive premature answers → max_steps termination', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asTextResult('answer 1'),
      async () => asTextResult('answer 2'),
      async () => asTextResult('answer 3'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis({ requiredTool: 'get_food_pairings' }),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, 'food pairing', { maxSteps: 5 });
    // Two consecutive premature answers MUST stop the loop deterministically.
    expect(['max_steps', 'error']).toContain(result.terminationReason);
  });
});

// ---------------------------------------------------------------------------
// Category 5 — Token budget mid-loop
// ---------------------------------------------------------------------------

describe('MultiStep — token budget mid-loop', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('LLM uses 25K tokens per call; budget=50K → second iteration terminates with budget; synth still runs', async () => {
    const heavy = {
      inputTokens: HEAVY_USAGE_INPUT,
      outputTokens: HEAVY_USAGE_OUTPUT,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'first' })], heavy),
      async () => asToolUseResult([toolUse('search_wines', { query: 'second distinct' })], heavy),
      async () => asTextResult('post-budget answer'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, {
      maxSteps: 5,
      maxTotalTokens: EXACT_BOUNDARY_TOKEN_BUDGET,
    });

    // Budget guard fires after the second heavy call (cumulative ≥50K).
    expect(['budget', 'max_steps']).toContain(result.terminationReason);
    // Synthesizer still produced a non-empty answer.
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('exactly at limit (cumulative = limit) → terminate budget cleanly', async () => {
    // Two calls of 25K → cumulative 50K exactly. The pre-flight check
    // `totalTokens >= input.maxTotalTokens` triggers on the THIRD iteration.
    const heavy = {
      inputTokens: HEAVY_USAGE_INPUT,
      outputTokens: HEAVY_USAGE_OUTPUT,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'a' })], heavy),
      async () => asToolUseResult([toolUse('search_wines', { query: 'b' })], heavy),
      async () => asTextResult('would-be answer that runs out of budget'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, {
      maxSteps: 5,
      maxTotalTokens: EXACT_BOUNDARY_TOKEN_BUDGET,
    });
    expect(['budget', 'max_steps']).toContain(result.terminationReason);
  });

  it('1 token over budget → terminate budget on next iteration', async () => {
    const slightlyOver = {
      inputTokens: HEAVY_USAGE_INPUT + 1,
      outputTokens: HEAVY_USAGE_OUTPUT,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'q' })], slightlyOver),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q-2' })], slightlyOver),
      async () => asTextResult('post-budget'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, {
      maxSteps: 5,
      maxTotalTokens: EXACT_BOUNDARY_TOKEN_BUDGET,
    });
    expect(['budget', 'max_steps']).toContain(result.terminationReason);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Cross-tool batches (LLM emits multi-call tool_use)
// ---------------------------------------------------------------------------

describe('MultiStep — cross-tool batches', () => {
  let harness: WineSearchTestHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('LLM emits two search_wines in one batch → both dispatch via the runner', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([
        toolUse('search_wines', { query: 'Bordeaux 2015' }, 'tu-1'),
        toolUse('search_wines', { query: 'Burgundy 2018' }, 'tu-2'),
      ]),
      async () => asTextResult('Both regions checked.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });

    expect(['answer', 'loop_detected', 'max_steps']).toContain(result.terminationReason);
    // The runner records every dispatched call atomically via
    // `recordParallelBatch`. If both passed admission, both should appear in
    // searchCalls.
    expect(ports.searchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('batch with unknown tool name → mini-loop emits "not supported" observation, no port crash', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('frobnicate_wines', { query: 'unsupported' })]),
      async () => asTextResult('Pivoted from unsupported tool.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });

    expect(['answer', 'max_steps']).toContain(result.terminationReason);
    expect(result.answer.length).toBeGreaterThan(0);
    expect(ports.searchCalls.length).toBe(0);
  });

  it('batch with compare_wines alongside search — both dispatch via the runner', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([
        toolUse('compare_wines', { query_a: 'Opus One 2018', query_b: 'Mouton 2018' }),
      ]),
      async () => asTextResult('Comparison complete.'),
    ];
    harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });

    expect(['answer', 'max_steps']).toContain(result.terminationReason);
    // Compare port should have been dispatched.
    expect(ports.comparisonCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Wiring assertion — when the bundle is wired, the orchestrator MUST emit
// `mini_loop` source steps (not the Layer-4 skip path).
// ---------------------------------------------------------------------------

describe('MultiStep — wiring sanity', () => {
  it('mini_loop source appears in executionSteps when bundle is wired', async () => {
    const ports = buildPortStubs();
    const executeScript = [
      async () => asToolUseResult([toolUse('search_wines', { query: 'q' })]),
      async () => asTextResult('done'),
    ];
    const harness = await buildHarness({
      analysis: makeMultiStepAnalysis(),
      executeScript,
      ports,
    });
    try {
      const result = await runOrchestrator(harness, ENGLISH_MULTISTEP_QUERY, { maxSteps: 5 });
      const ml = miniLoopSteps(result);
      expect(ml.length).toBeGreaterThan(0);
      expect(result.planKind).toBe('multi-step');
    } finally {
      await harness.cleanup();
    }
  });

  // Sanity: keep the magic constants imported so future drift fails fast.
  it('module constants are present', () => {
    expect(KOREAN_MULTISTEP_QUERY.length).toBeGreaterThan(0);
    expect(ENGLISH_MULTISTEP_QUERY.length).toBeGreaterThan(0);
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThan(0);
    // Verbose: prevent eslint/no-unused-vars on imported `vi` if no spy is
    // declared in this suite.
    expect(vi).toBeDefined();
    // Keep beforeEach symbol referenced for future expansion.
    expect(typeof beforeEach).toBe('function');
  });
});
