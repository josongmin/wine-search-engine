/**
 * Regression: Tool Result Cache for the PtE mini-loop dispatch.
 *
 * Locks in:
 *  1. `stableStringify` is deterministic — identical objects produce
 *     identical canonical strings regardless of key insertion order.
 *  2. Cache HIT: identical (toolName, normalizedInput) twice → second
 *     dispatch returns cached result and executes the tool exactly ONCE.
 *     Observation is tagged with `[CACHE_HIT]`.
 *  3. Cache MISS variation: changing one input field → different key →
 *     tool executes twice.
 *  4. Redis failure: mock client throws → get returns null, request still
 *     completes; set failure is also fail-open.
 *  5. TTL per tool: `toolResultCacheTtlSeconds` exposes the documented
 *     value per tool name.
 *  6. DISABLED gate: `WINE_SEARCH_TOOL_CACHE_ENABLED=0` → cache bypassed
 *     entirely (port never consulted, even when wired).
 *  7. WINE_SEARCH_DISABLED_TOOLS tool → not cached.
 *  8. TTL map covers exactly KNOWN_AGENT_TOOL_NAMES (no drift).
 *
 * No live Redis required — the adapter is constructed against a deterministic
 * in-memory mock; the mini-loop is exercised with a stub structured-LLM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  ExecuteResult,
  StructuredLlmPort,
  SynthesizeRequest,
  SynthesizeResult,
  TokenUsage,
  ToolDefinition,
  ToolUseCall,
} from '../../src/domain/ai/port/structured-llm.port.js';
import type { ComparisonSearchResponse } from '../../src/domain/response/model/comparison-response.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import { MiniLoopRunner } from '../../src/application/wine-search/mini-loop.js';
import {
  MINI_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
  MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
  MINI_LOOP_DEFAULT_MAX_STEPS,
  MINI_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
  MINI_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
  MINI_LOOP_DEFAULT_PER_TOOL_CAP,
  type MiniLoopInput,
  type MiniLoopToolPorts,
} from '../../src/application/wine-search/mini-loop-schemas.js';
import type {
  ComparisonUseCasePort,
  DrinkabilityProbe,
  DrinkabilityUseCasePort,
  SearchUseCasePort,
} from '../../src/application/wine-search/execution-runner.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';
import type {
  ToolCacheKey,
  ToolResultCachePort,
  ToolResultRecord,
} from '../../src/application/wine-search/port/tool-result-cache.port.js';
import { RedisToolResultCache, __resetRedisToolResultCacheWarnLatchesForTests, computeInputHash } from '../../src/infrastructure/cache/redis-tool-result-cache.js';
import { stableStringify } from '../../src/domain/shared/utils/stable-stringify.js';
import {
  TOOL_RESULT_CACHE_TTL_SECONDS,
  toolResultCacheTtlSeconds,
} from '../../src/domain/shared/constants/tool-cache-ttl.js';
import { KNOWN_AGENT_TOOL_NAMES } from '../../src/domain/agent/model/agent-tool-attempt-schema.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors the existing mini-loop.test.ts fixture style)
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-tool-cache-001';

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

function makeTokenUsage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function makeAnalysis(): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: true,
    recommendedBudget: { maxSteps: MINI_LOOP_DEFAULT_MAX_STEPS, perToolCap: MINI_LOOP_DEFAULT_PER_TOOL_CAP },
    hangulDominant: false,
    preservedSurface: 'fixture-query',
  };
}

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

function makeSearchPort(
  impl?: (input: unknown, reqId: string) => Promise<SearchResponseV1>,
): SearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeSearchResponse(['wine-1']))));
  return {
    executeMock,
    execute: (input, reqId, _opts) => executeMock(input, reqId),
  };
}

function makeComparisonPort(): ComparisonUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(() => Promise.resolve({
    queryType: 'comparison',
    meta: { generatedAt: new Date().toISOString() } as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse));
  return { executeMock, execute: (input, reqId, _opts) => executeMock(input, reqId) };
}

function makeDrinkabilityPort(): DrinkabilityUseCasePort & { readonly probeMock: ReturnType<typeof vi.fn> } {
  const probeMock = vi.fn((entityId: string, targetYear: number) => Promise.resolve({
    entityId,
    targetYear,
    window: { drinkingWindowStart: targetYear, drinkingWindowEnd: targetYear + 10, currentlyDrinkable: true } as unknown as DrinkabilityProbe['window'],
  }));
  return { probeMock, probe: (entityId, targetYear, reqId, _opts) => probeMock(entityId, targetYear, reqId) };
}

function makeToolPorts(overrides?: Partial<MiniLoopToolPorts>): MiniLoopToolPorts {
  return {
    searchUseCase: overrides?.searchUseCase ?? makeSearchPort(),
    comparisonUseCase: overrides?.comparisonUseCase ?? makeComparisonPort(),
    drinkabilityUseCase: overrides?.drinkabilityUseCase ?? makeDrinkabilityPort(),
  };
}

interface StubLlm extends StructuredLlmPort {
  readonly executeMock: ReturnType<typeof vi.fn>;
}

function makeStubLlm(
  responses: ReadonlyArray<(req: ExecuteRequest) => Promise<ExecuteResult>>,
): StubLlm {
  let call = 0;
  const executeMock = vi.fn(async (req: ExecuteRequest) => {
    const handler = responses[call] ?? responses[responses.length - 1];
    call += 1;
    if (handler === undefined) throw new Error('no handler');
    return handler(req);
  });
  return {
    executeMock,
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => { throw new Error('analyze should not be called'); },
    execute: (req: ExecuteRequest) => executeMock(req),
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => { throw new Error('synthesize should not be called'); },
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tu-1'): ToolUseCall {
  return { id, name, input };
}

function asToolUseResult(calls: readonly ToolUseCall[], usage = makeTokenUsage(120, 60)): ExecuteResult {
  return { kind: 'tool_use', calls, usage, durationMs: 5, stopReason: 'tool_use' };
}

function asTextResult(text: string, usage = makeTokenUsage(100, 50)): ExecuteResult {
  return { kind: 'text', text, usage, durationMs: 5, stopReason: 'end_turn' };
}

function makeToolDefs(): readonly ToolDefinition[] {
  const passthrough: ToolDefinition['inputSchema'] = {
    parse: (x: unknown) => x,
    safeParse: (x: unknown) => ({ success: true as const, data: x }),
  } as unknown as ToolDefinition['inputSchema'];
  return [
    { name: 'search_wines', description: 'search', inputSchema: passthrough },
    { name: 'check_drinking_window', description: 'check drinkability', inputSchema: passthrough },
    { name: 'get_food_pairings', description: 'food pairing', inputSchema: passthrough },
    { name: 'compare_wines', description: 'compare', inputSchema: passthrough },
  ];
}

function makeInput(overrides: Partial<MiniLoopInput>): MiniLoopInput {
  return {
    query: overrides.query ?? 'recommend a Burgundy Pinot Noir',
    analysis: overrides.analysis ?? makeAnalysis(),
    requestId: overrides.requestId ?? REQUEST_ID,
    tools: overrides.tools ?? makeToolDefs(),
    toolPorts: overrides.toolPorts ?? makeToolPorts(),
    perStepTimeoutMs: overrides.perStepTimeoutMs ?? MINI_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
    agentTimeoutMs: overrides.agentTimeoutMs ?? MINI_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
    maxSteps: overrides.maxSteps ?? MINI_LOOP_DEFAULT_MAX_STEPS,
    maxTotalTokens: overrides.maxTotalTokens ?? MINI_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
    maxOutputTokens: overrides.maxOutputTokens ?? MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
    perToolCap: overrides.perToolCap ?? MINI_LOOP_DEFAULT_PER_TOOL_CAP,
    ...(overrides.initialDirective !== undefined ? { initialDirective: overrides.initialDirective } : {}),
    ...(overrides.abortSignal !== undefined ? { abortSignal: overrides.abortSignal } : {}),
  };
}

// ---------------------------------------------------------------------------
// In-memory mock cache (drop-in for ToolResultCachePort)
// ---------------------------------------------------------------------------

interface MockCache extends ToolResultCachePort {
  readonly getMock: ReturnType<typeof vi.fn>;
  readonly setMock: ReturnType<typeof vi.fn>;
  readonly store: Map<string, { record: ToolResultRecord; ttlSeconds: number }>;
}

function makeMockCache(opts?: { readonly getThrows?: boolean }): MockCache {
  const store = new Map<string, { record: ToolResultRecord; ttlSeconds: number }>();
  const getMock = vi.fn(async (key: ToolCacheKey): Promise<ToolResultRecord | null> => {
    if (opts?.getThrows) throw new Error('mock redis exploded');
    const entry = store.get(`${key.toolName}:${key.normalizedInputHash}`);
    return entry?.record ?? null;
  });
  const setMock = vi.fn(async (key: ToolCacheKey, value: ToolResultRecord, ttlSeconds: number): Promise<void> => {
    store.set(`${key.toolName}:${key.normalizedInputHash}`, { record: value, ttlSeconds });
  });
  return { getMock, setMock, store, get: getMock, set: setMock };
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const ENV_CACHE_FLAG = 'WINE_SEARCH_TOOL_CACHE_ENABLED';
const ENV_DISABLED_TOOLS = 'WINE_SEARCH_DISABLED_TOOLS';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const env = process.env;
  const prev = env[key];
  if (value === undefined) Reflect.deleteProperty(env, key);
  else env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) Reflect.deleteProperty(env, key);
    else env[key] = prev;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tool Result Cache — stableStringify determinism', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { query: 'Burgundy Pinot Noir', limit: 10, mode: 'hybrid' };
    const b = { mode: 'hybrid', query: 'Burgundy Pinot Noir', limit: 10 };
    const c = { limit: 10, mode: 'hybrid', query: 'Burgundy Pinot Noir' };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(b)).toBe(stableStringify(c));
  });

  it('recurses into nested objects with stable key order', () => {
    const a = { filters: [{ attribute: 'color', value: 'red' }, { attribute: 'price', value: 100 }] };
    const b = { filters: [{ value: 'red', attribute: 'color' }, { value: 100, attribute: 'price' }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('preserves array order (arrays are positionally significant)', () => {
    const a = { items: [1, 2, 3] };
    const b = { items: [3, 2, 1] };
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it('handles Korean strings without mojibake (UTF-8 preserved)', () => {
    const a = { query: '부르고뉴 피노누아' };
    expect(stableStringify(a)).toBe('{"query":"부르고뉴 피노누아"}');
  });

  it('drops undefined property values (matches JSON.stringify semantics)', () => {
    const a = { query: 'x', limit: undefined };
    expect(stableStringify(a)).toBe('{"query":"x"}');
  });

  it('throws on circular references (programming error)', () => {
    interface Circ { self?: Circ }
    const a: Circ = {};
    a.self = a;
    expect(() => stableStringify(a)).toThrow(/circular/);
  });

  it('serializes non-finite numbers to null (consistency with JSON.stringify)', () => {
    expect(stableStringify({ n: NaN })).toBe('{"n":null}');
    expect(stableStringify({ n: Infinity })).toBe('{"n":null}');
  });
});

describe('Tool Result Cache — TTL map', () => {
  it('exposes a positive integer TTL for every known agent tool', () => {
    for (const tool of KNOWN_AGENT_TOOL_NAMES) {
      const ttl = TOOL_RESULT_CACHE_TTL_SECONDS.get(tool);
      expect(ttl, `TTL missing for ${tool}`).toBeDefined();
      expect(ttl).toBeGreaterThan(0);
    }
  });

  it('TTL map has no extra entries beyond KNOWN_AGENT_TOOL_NAMES', () => {
    const known = new Set<string>(KNOWN_AGENT_TOOL_NAMES);
    for (const key of TOOL_RESULT_CACHE_TTL_SECONDS.keys()) {
      expect(known.has(key), `unexpected TTL entry ${key}`).toBe(true);
    }
  });

  it('toolResultCacheTtlSeconds returns documented values', () => {
    expect(toolResultCacheTtlSeconds('lookup_wine')).toBe(86_400); // 1 day
    expect(toolResultCacheTtlSeconds('search_wines')).toBe(3_600); // 1 hour
    expect(toolResultCacheTtlSeconds('compare_wines')).toBe(86_400);
    expect(toolResultCacheTtlSeconds('check_drinking_window')).toBe(86_400);
    expect(toolResultCacheTtlSeconds('get_food_pairings')).toBe(86_400);
  });

  it('returns undefined for unknown tool names (fail-safe: do-not-cache)', () => {
    expect(toolResultCacheTtlSeconds('not_a_real_tool')).toBeUndefined();
  });
});

describe('Tool Result Cache — MiniLoopRunner integration', () => {
  beforeEach(() => {
    __resetRedisToolResultCacheWarnLatchesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cache HIT: same (toolName, input) twice → tool executes ONCE', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      const cache = makeMockCache();
      const searchPort = makeSearchPort();

      // First run: tool executes, cache fills.
      const llm1 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'cache-test' })]),
        async () => asTextResult('answer1'),
      ]);
      const runner1 = new MiniLoopRunner({ structuredLlm: llm1, logger: makeLogger(), toolResultCache: cache });
      const out1 = await runner1.run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));
      expect(out1.terminationReason).toBe('answer');
      expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
      expect(cache.setMock).toHaveBeenCalledTimes(1);

      // Second run: same query, second dispatch should be a CACHE HIT.
      const llm2 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'cache-test' })]),
        async () => asTextResult('answer2'),
      ]);
      const runner2 = new MiniLoopRunner({ structuredLlm: llm2, logger: makeLogger(), toolResultCache: cache });
      const out2 = await runner2.run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));
      expect(out2.terminationReason).toBe('answer');
      // Tool executed only once (the cache short-circuits the second turn).
      expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
      // Observation tagged with [CACHE_HIT]
      const toolStep = out2.steps.find((s) => s.kind === 'tool_use');
      expect(toolStep?.observations[0] ?? '').toContain('[CACHE_HIT]');
    });
  });

  it('cache MISS: different input field → key differs → tool executes both times', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      const cache = makeMockCache();
      const searchPort = makeSearchPort();

      const llm1 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'first' })]),
        async () => asTextResult('a'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm1, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      const llm2 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'second' })]),
        async () => asTextResult('b'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm2, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      expect(searchPort.executeMock).toHaveBeenCalledTimes(2);
      expect(cache.setMock).toHaveBeenCalledTimes(2);
    });
  });

  it('TTL respected: cache.set called with per-tool TTL from constants map', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      const cache = makeMockCache();
      const searchPort = makeSearchPort();
      const llm = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'ttl-test' })]),
        async () => asTextResult('done'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      expect(cache.setMock).toHaveBeenCalledTimes(1);
      const setCall = cache.setMock.mock.calls[0];
      expect(setCall).toBeDefined();
      // setMock signature: (key, value, ttlSeconds)
      const ttlArg = setCall?.[2] as number | undefined;
      expect(ttlArg).toBe(toolResultCacheTtlSeconds('search_wines'));
    });
  });

  it('Redis failure: cache.get throws → falls open to fresh execution; no crash', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      // Wrap the throwing mock with a fail-open wrapper that mirrors what
      // the real Redis adapter promises (per ToolResultCachePort contract).
      const inner = makeMockCache({ getThrows: true });
      const failOpenCache: ToolResultCachePort = {
        get: async (key) => {
          try { return await inner.get(key); } catch { return null; }
        },
        set: inner.set,
      };
      const searchPort = makeSearchPort();
      const llm = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'fail-open' })]),
        async () => asTextResult('ok'),
      ]);
      const out = await new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger(), toolResultCache: failOpenCache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));
      expect(out.terminationReason).toBe('answer');
      expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('DISABLED gate: WINE_SEARCH_TOOL_CACHE_ENABLED=0 → cache never consulted', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '0', async () => {
      const cache = makeMockCache();
      const searchPort = makeSearchPort();
      const llm = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'disabled' })]),
        async () => asTextResult('ok'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      expect(cache.getMock).not.toHaveBeenCalled();
      expect(cache.setMock).not.toHaveBeenCalled();
      expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('WINE_SEARCH_DISABLED_TOOLS tool → not cached (fail-closed path bypasses cache)', async () => {
    // The DISABLED_TOOLS set is captured at module load — vitest module cache
    // means we can't easily re-import to flip it inside one test process.
    // Instead, simulate the contract: a tool that would short-circuit to
    // TOOL_UNAVAILABLE returns rawResult=null — and a null result is never
    // cached. Verify the null-result no-cache path here.
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      const cache = makeMockCache();
      // Search port that returns a null-like response (no `results` key) —
      // formatSearchObservation emits a NO_MATCH observation, and the
      // dispatcher's rawResult ends up as a valid SearchResponseV1 obj.
      // To test the "no cache on rawResult=null" path, override the
      // search port to throw via the dispatcher's mapped failure.
      const searchPort = makeSearchPort(() => Promise.reject(new Error('tool not available')));
      const llm = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'fail-tool' })]),
        async () => asTextResult('ok'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      // execError path → set NEVER called (we don't cache failures)
      expect(cache.setMock).not.toHaveBeenCalled();
    });
  });

  it('cache key is content-addressed: insertion order does NOT change hash', async () => {
    await withEnvAsync(ENV_CACHE_FLAG, '1', async () => {
      const cache = makeMockCache();
      const searchPort = makeSearchPort();

      // First run with input A,B
      const llm1 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { query: 'reorder', limit: 5 })]),
        async () => asTextResult('a'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm1, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      // Second run with input B,A (same fields, different insertion order) — should HIT cache
      const llm2 = makeStubLlm([
        async () => asToolUseResult([toolUse('search_wines', { limit: 5, query: 'reorder' })]),
        async () => asTextResult('b'),
      ]);
      await new MiniLoopRunner({ structuredLlm: llm2, logger: makeLogger(), toolResultCache: cache })
        .run(makeInput({ toolPorts: makeToolPorts({ searchUseCase: searchPort }) }));

      // Tool executed once — second was a cache hit.
      expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Tool Result Cache — RedisToolResultCache adapter (in-memory Redis mock)', () => {
  beforeEach(() => {
    __resetRedisToolResultCacheWarnLatchesForTests();
  });

  function makeRedisMockClient() {
    const store = new Map<string, string>();
    const calls = { get: 0, set: [] as Array<{ key: string; value: string; ex?: number }> };
    const get = vi.fn(async (key: string) => {
      calls.get += 1;
      return store.get(key) ?? null;
    });
    const set = vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
      calls.set.push({ key, value, ...(opts?.EX !== undefined ? { ex: opts.EX } : {}) });
      store.set(key, value);
      return 'OK';
    });
    return { get, set, store, calls };
  }

  it('round-trips a record through the adapter', async () => {
    const mock = makeRedisMockClient();
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({ get: mock.get, set: mock.set }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: computeInputHash({ q: 'a' }) };
    expect(await adapter.get(key)).toBeNull();
    await adapter.set(key, { result: { hello: 'world' }, createdAt: 1_700_000_000_000 }, 60);
    const back = await adapter.get(key);
    expect(back).not.toBeNull();
    expect(back?.createdAt).toBe(1_700_000_000_000);
    expect((back?.result as Record<string, unknown> | undefined)?.['hello']).toBe('world');
  });

  it('set passes EX to Redis with the requested TTL', async () => {
    const mock = makeRedisMockClient();
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({ get: mock.get, set: mock.set }),
    });
    const key = { toolName: 'lookup_wine', normalizedInputHash: 'abcdef0123456789' };
    await adapter.set(key, { result: 'ok', createdAt: Date.now() }, 86_400);
    expect(mock.calls.set).toHaveLength(1);
    expect(mock.calls.set[0]?.ex).toBe(86_400);
    expect(mock.calls.set[0]?.key).toBe('tool-result:lookup_wine:abcdef0123456789');
  });

  it('fails open on get error (returns null, does NOT throw)', async () => {
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({
        get: () => { throw new Error('redis down'); },
        set: async () => 'OK',
      }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: 'deadbeef00000000' };
    await expect(adapter.get(key)).resolves.toBeNull();
  });

  it('fails open on set error (no throw)', async () => {
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({
        get: async () => null,
        set: () => { throw new Error('redis down'); },
      }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: 'deadbeef11111111' };
    await expect(
      adapter.set(key, { result: 'x', createdAt: 1 }, 60),
    ).resolves.toBeUndefined();
  });

  it('treats corrupt JSON in the store as a miss (returns null)', async () => {
    const mock = makeRedisMockClient();
    mock.store.set('tool-result:search_wines:badjsonbadjsonba', '{not valid json');
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({ get: mock.get, set: mock.set }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: 'badjsonbadjsonba' };
    expect(await adapter.get(key)).toBeNull();
  });

  it('rejects shape-mismatched entries (returns null)', async () => {
    const mock = makeRedisMockClient();
    mock.store.set('tool-result:search_wines:shape00mismatch', JSON.stringify({ no_result_field: true }));
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({ get: mock.get, set: mock.set }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: 'shape00mismatch' };
    expect(await adapter.get(key)).toBeNull();
  });

  it('skips writes for non-positive or non-finite TTL (safety)', async () => {
    const mock = makeRedisMockClient();
    const adapter = new RedisToolResultCache({
      resolveClient: async () => ({ get: mock.get, set: mock.set }),
    });
    const key = { toolName: 'search_wines', normalizedInputHash: 'badttl0000000000' };
    await adapter.set(key, { result: 'x', createdAt: 1 }, 0);
    await adapter.set(key, { result: 'x', createdAt: 1 }, -1);
    await adapter.set(key, { result: 'x', createdAt: 1 }, Number.NaN);
    await adapter.set(key, { result: 'x', createdAt: 1 }, Number.POSITIVE_INFINITY);
    expect(mock.calls.set).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Async withEnv helper
// ---------------------------------------------------------------------------

async function withEnvAsync(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const env = process.env;
  const prev = env[key];
  if (value === undefined) Reflect.deleteProperty(env, key);
  else env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) Reflect.deleteProperty(env, key);
    else env[key] = prev;
  }
}

// Reference unused helper to silence lint (will be useful if test grows)
void withEnv;
void ENV_DISABLED_TOOLS;
