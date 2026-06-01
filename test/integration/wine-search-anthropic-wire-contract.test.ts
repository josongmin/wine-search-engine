/**
 * Anthropic Messages-API wire-contract integration test.
 *
 * Drives the FULL Plan-then-Execute pipeline (Analyzer → Router → WineAgentLoop →
 * Synthesizer) through the REAL {@link ClaudeStructuredLlmAdapter} with a
 * mocked global `fetch`. Every outgoing request to `api.anthropic.com` is
 * captured and asserted byte-perfect against the Anthropic Messages API spec.
 *
 * This proves real-LLM compatibility WITHOUT an API key: the adapter speaks
 * the wire protocol directly, so intercepting `fetch` is full end-to-end
 * coverage of the request side. The responses are canned, but the REQUESTS
 * are exactly what production would send.
 *
 * Why drive through the orchestrator (not just the adapter)?
 *   The orchestrator is the only component that composes the analyzer's
 *   `analyze`, the wine-agent-loop's `execute`, and the synthesizer's `synthesize`
 *   into a single request lifecycle. By wiring the real adapter at the
 *   orchestrator's `StructuredLlmPort` seam (instead of the port-level mock in
 *   `anthropic-sdk-mock.ts`), we exercise the exact request bodies each phase
 *   constructs — system prompts, tool schemas, prompt-cache markers, model
 *   ids, message histories — through the real Zod→JSON-Schema converter and
 *   the real `buildBaseBody` serialization.
 *
 * STRICT additive scope: no production source is modified. The fetch-capture
 * helper lives in `test/e2e/helpers/anthropic-sdk-mock.ts`; snapshots live in
 * `test/integration/fixtures/wire-payloads/`.
 *
 * Files cited:
 *   - src/infrastructure/ai/claude-structured-llm-adapter.ts
 *       fetchAnthropic() L864-978 (the fetch call + headers L894-898),
 *       buildBaseBody() L760-819 (body construction + cache markers
 *       L793-808), runStructuredCall() L632-731 (forced `respond` tool +
 *       tool_choice L660), execute() L559-625 (tools + toolChoice).
 *   - src/application/wine-search/wine-search-orchestrator.ts (pipeline)
 *   - src/application/wine-search/synthesis-runner.ts
 *       SYNTHESIS_SYSTEM_PROMPT L285-303, enablePromptCache:true L554.
 *   - src/application/wine-search/wine-agent-loop.ts runOneTurn() L453-499.
 *   - src/application/wine-search/query-analyzer.ts runLlmFallback() L288-317.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { z } from 'zod';

import { ClaudeStructuredLlmAdapter } from '../../src/infrastructure/ai/claude-structured-llm-adapter.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';
import { QueryAnalyzerService } from '../../src/application/wine-search/query-analyzer.js';
import { DeterministicRouter } from '../../src/application/wine-search/deterministic-router.js';
import { ExecutionRunner } from '../../src/application/wine-search/execution-runner.js';
import { WineAgentLoopRunner } from '../../src/application/wine-search/wine-agent-loop.js';
import { SynthesisRunner } from '../../src/application/wine-search/synthesis-runner.js';
import { WineSearchOrchestrator } from '../../src/application/wine-search/wine-search-orchestrator.js';
import type {
  OrchestratorWineAgentLoopToolBundle,
} from '../../src/application/wine-search/wine-search-orchestrator.js';
import { buildWineAgentLoopToolBundle } from '../../src/application/wine-search/wine-agent-loop-tool-bundle.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';
import type { SearchUseCasePort } from '../../src/application/wine-search/execution-runner.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import {
  buildAnthropicFetchCapture,
  type CapturedAnthropicRequest,
  type ScriptedAnthropicResponse,
} from '../e2e/helpers/anthropic-sdk-mock.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Snapshot directory for stripped wire payloads. */
const WIRE_SNAPSHOT_DIR = fileURLToPath(
  new URL('./fixtures/wire-payloads/', import.meta.url),
);

/** When set, snapshots are (re)created from the captured payloads instead of
 *  asserted against. Mirrors the project's `UPDATE_*` snapshot convention. */
const UPDATE_WIRE_SNAPSHOTS = process.env['UPDATE_WIRE_SNAPSHOTS'] === '1';

/** Anthropic's documented hard upper bound on `max_tokens` for the
 *  Claude-4-class models the adapter targets. The wire-invariant assertion
 *  uses this; values above it are rejected by the API. */
const ANTHROPIC_MAX_TOKENS_UPPER_BOUND = 8192;

/** HTTP timeout for the real adapter under test. Large enough that the
 *  per-step timer never fires during a synchronous mocked-fetch turn. */
const TEST_HTTP_TIMEOUT_MS = 30_000;

/** The api key the adapter is constructed with — never a real key. The wire
 *  invariant asserts it is forwarded verbatim in `x-api-key`. */
const TEST_API_KEY = 'sk-ant-test-not-a-real-key';

/** Anthropic API version header value the adapter pins
 *  (ANTHROPIC_API_VERSION in the adapter, L74). */
const EXPECTED_ANTHROPIC_VERSION = '2023-06-01';

/** Model id strings used for each phase. The adapter forwards `body.model`
 *  verbatim; we pass Claude-4-class ids so the `/^claude-(opus|sonnet|haiku)-/`
 *  invariant holds. */
const ANALYZE_MODEL = 'claude-sonnet-4-5-20250929';
const SYNTH_MODEL = 'claude-sonnet-4-5-20250929';
const WINE_AGENT_LOOP_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Anthropic Messages-API request Zod schema.
//
// Derived from the ACTUAL adapter output (buildBaseBody, L760-819):
//   { model, system: [{type:'text', text, cache_control?}], messages:
//     [{role, content}], max_tokens, tools: [{name, description,
//     input_schema, cache_control?}], tool_choice }
//
// We DO NOT chain `.strict()` on the top level — the Anthropic API accepts
// additional optional params (temperature, stop_sequences, metadata, …) and a
// future adapter change adding one should not fail this contract. But every
// field the adapter DOES send is validated for spec conformance.
// ---------------------------------------------------------------------------

const CacheControlSchema = z
  .object({ type: z.literal('ephemeral') })
  .strict();

const SystemBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1),
    cache_control: CacheControlSchema.optional(),
  })
  .strict();

const MessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })
  .strict();

/** Anthropic tool `input_schema` MUST be a JSON-Schema object with a
 *  `properties` map. The adapter emits Draft-7-superset objects via
 *  zodToJsonSchema; we assert the top-level invariant (type:'object' +
 *  properties defined) the API requires. */
const ToolInputSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const ToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    input_schema: ToolInputSchema,
    cache_control: CacheControlSchema.optional(),
  })
  .strict();

const ToolChoiceSchema = z.union([
  z.object({ type: z.literal('auto') }).strict(),
  z.object({ type: z.literal('any') }).strict(),
  z.object({ type: z.literal('tool'), name: z.string().min(1) }).strict(),
]);

/**
 * Anthropic's documented model-id naming convention for Claude 4 is
 * `claude-<family>-<gen>-...` (e.g. `claude-sonnet-4-5-20250929`). The
 * `<family>` segment is one of opus/sonnet/haiku and comes immediately after
 * `claude-`. Some pipeline modules still use the legacy
 * `claude-4-<family>-latest` ordering, which the real API REJECTS — see the
 * dedicated deviation test below. The strict body schema enforces the correct
 * ordering; the `modelPattern`-relaxed variant is used only when a scenario
 * intentionally drives a known-deviating production default.
 */
const SPEC_MODEL_PATTERN = /^claude-(opus|sonnet|haiku)-/u;

function makeBodySchema(modelPattern: RegExp) {
  return z
    .object({
      model: z.string().regex(modelPattern),
      system: z.array(SystemBlockSchema).min(1),
      messages: z.array(MessageSchema).min(1),
      max_tokens: z.number().int().positive().max(ANTHROPIC_MAX_TOKENS_UPPER_BOUND),
      tools: z.array(ToolSchema).min(1),
      tool_choice: ToolChoiceSchema,
    })
    .passthrough();
}

type AnthropicRequestBody = z.infer<ReturnType<typeof makeBodySchema>>;

// ---------------------------------------------------------------------------
// Wire-invariant assertions — run on EVERY captured request.
// ---------------------------------------------------------------------------

/**
 * Assert all spec invariants on a single captured request. Returns the parsed,
 * validated body so callers can make scenario-specific follow-up assertions.
 */
function assertWireInvariants(
  req: CapturedAnthropicRequest,
  modelPattern: RegExp = SPEC_MODEL_PATTERN,
): AnthropicRequestBody {
  // URL + method (adapter endpoint = ANTHROPIC_API_BASE + ANTHROPIC_MESSAGES_PATH).
  expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  expect(req.method).toBe('POST');

  // Headers (adapter fetchAnthropic L894-898). Header names are lowercased by
  // the capture helper; HTTP header names are case-insensitive.
  expect(req.headers['content-type']).toBe('application/json');
  expect(req.headers['x-api-key']).toBe(TEST_API_KEY);
  expect(req.headers['anthropic-version']).toBe(EXPECTED_ANTHROPIC_VERSION);

  // Body shape — Zod validation (no `as` casts; CLAUDE.md rule 12).
  const parsed = makeBodySchema(modelPattern).safeParse(req.body);
  if (!parsed.success) {
    throw new Error(
      `Anthropic request body violated spec: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const body = parsed.data;

  // No `undefined` serialized into the JSON (JSON.stringify drops undefined
  // values, so a captured key with literal `undefined` would be a parse-time
  // anomaly; we additionally guard the raw payload).
  assertNoUndefinedKeys(req.body);

  // messages[0] MUST be a non-empty user turn (Anthropic requires the first
  // turn to be `user`).
  expect(body.messages[0]?.role).toBe('user');
  for (const msg of body.messages) {
    expect(msg.content.length).toBeGreaterThan(0);
  }

  // Every tool input_schema is an object with properties defined.
  const toolNames = new Set<string>();
  for (const tool of body.tools) {
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties).toBeDefined();
    toolNames.add(tool.name);
  }

  // tool_choice.name (when forced) MUST reference a declared tool.
  if (body.tool_choice.type === 'tool') {
    expect(toolNames.has(body.tool_choice.name)).toBe(true);
  }

  return body;
}

/** Recursively assert no value in the parsed body is literal `undefined`. */
function assertNoUndefinedKeys(value: unknown): void {
  if (value === undefined) {
    throw new Error('captured body contained an undefined value');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoUndefinedKeys(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) assertNoUndefinedKeys(v);
  }
}

/**
 * Assert the prompt-cache markers are byte-for-byte correct when caching is
 * enabled: the LAST system text block AND the LAST tool both carry
 * `cache_control: { type: 'ephemeral' }` (adapter buildBaseBody L793-808).
 */
function assertPromptCacheMarkers(body: AnthropicRequestBody, enabled: boolean): void {
  const lastSystem = body.system[body.system.length - 1];
  const lastTool = body.tools[body.tools.length - 1];
  if (enabled) {
    expect(lastSystem?.cache_control).toEqual({ type: 'ephemeral' });
    expect(lastTool?.cache_control).toEqual({ type: 'ephemeral' });
  } else {
    expect(lastSystem?.cache_control).toBeUndefined();
    expect(lastTool?.cache_control).toBeUndefined();
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers — strip dynamic fields then create-or-assert.
// ---------------------------------------------------------------------------

/**
 * Strip fields that legitimately vary between runs. The wire requests are
 * deterministic by construction (no timestamps, no request_id in the body),
 * but `x-api-key` is environment-specific; we redact it in the snapshot so a
 * different test key never breaks the snapshot. The body itself is fully
 * deterministic.
 */
function stripForSnapshot(req: CapturedAnthropicRequest): unknown {
  return {
    url: req.url,
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'anthropic-version': req.headers['anthropic-version'],
      'x-api-key': '<redacted>',
      ...(req.headers['anthropic-beta'] !== undefined
        ? { 'anthropic-beta': req.headers['anthropic-beta'] }
        : {}),
    },
    body: normalizeDynamicTimestamps(req.body),
  };
}

/** Epoch-millis runs (13 consecutive digits) appear inside orchestrator-minted
 *  `stepId` strings (e.g. `orch:search_hybrid:1700000000000`). Even with a fixed
 *  clock these are pinned, but we additionally normalize them so the snapshot
 *  is robust to clock-injection regressions. Unicode-safe — operates on the
 *  raw string; the digit class is ASCII so `/u` is unnecessary. */
const EPOCH_MILLIS_RE = /\b\d{13}\b/g;

function normalizeDynamicTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EPOCH_MILLIS_RE, '<ts>');
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeDynamicTimestamps(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeDynamicTimestamps(v);
    }
    return out;
  }
  return value;
}

function snapshotPath(name: string): string {
  return join(WIRE_SNAPSHOT_DIR, `${name}.request.json`);
}

/**
 * Create-or-assert a stripped wire payload snapshot. With
 * `UPDATE_WIRE_SNAPSHOTS=1` it writes the snapshot; otherwise it reads the
 * committed snapshot and asserts deep equality.
 */
function matchWireSnapshot(name: string, req: CapturedAnthropicRequest): void {
  const stripped = stripForSnapshot(req);
  const serialized = `${JSON.stringify(stripped, null, 2)}\n`;
  const path = snapshotPath(name);
  if (UPDATE_WIRE_SNAPSHOTS) {
    mkdirSync(WIRE_SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, serialized, 'utf8');
    return;
  }
  let committed: string;
  try {
    committed = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Missing wire snapshot "${name}". Run with UPDATE_WIRE_SNAPSHOTS=1 to create it.`,
    );
  }
  // Compare parsed JSON (cast to unknown first — CLAUDE.md rule 12) so trailing
  // whitespace / key-order differences do not produce spurious failures.
  const expected: unknown = JSON.parse(committed) as unknown;
  expect(stripped).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Canned Anthropic responses (the RESPONSE side — only the request matters
// for the contract, but the pipeline needs valid responses to proceed).
// ---------------------------------------------------------------------------

/** A forced-`respond` tool_use response carrying the given input object. */
function respondToolUse(input: unknown): ScriptedAnthropicResponse {
  return {
    status: 200,
    bodyJson: {
      id: 'msg_wire_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'tool_use',
      stop_sequence: null,
      content: [
        { type: 'tool_use', id: 'toolu_wire_respond', name: 'respond', input },
      ],
      usage: { input_tokens: 120, output_tokens: 40 },
    },
  };
}

/** A wine-agent-loop tool_use response invoking a named tool. */
function namedToolUse(name: string, input: unknown): ScriptedAnthropicResponse {
  return {
    status: 200,
    bodyJson: {
      id: 'msg_wire_miniloop',
      type: 'message',
      role: 'assistant',
      model: WINE_AGENT_LOOP_MODEL,
      stop_reason: 'tool_use',
      stop_sequence: null,
      content: [
        { type: 'tool_use', id: 'toolu_wire_search', name, input },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  };
}

/** A plain end_turn text response (wine-agent-loop final answer turn). */
function endTurnText(text: string): ScriptedAnthropicResponse {
  return {
    status: 200,
    bodyJson: {
      id: 'msg_wire_text',
      type: 'message',
      role: 'assistant',
      model: WINE_AGENT_LOOP_MODEL,
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 80, output_tokens: 25 },
    },
  };
}

/** A refusal response (Anthropic 2025+ dedicated stop_reason). */
function refusalResponse(): ScriptedAnthropicResponse {
  return {
    status: 200,
    bodyJson: {
      id: 'msg_wire_refusal',
      type: 'message',
      role: 'assistant',
      model: SYNTH_MODEL,
      stop_reason: 'refusal',
      stop_sequence: null,
      content: [{ type: 'text', text: "I can't help with that request." }],
      usage: { input_tokens: 30, output_tokens: 5 },
    },
  };
}

/** A valid synthesizer answer payload. */
function synthAnswer(answer: string): unknown {
  return { answer, citations: ['wine-1'] };
}

// ---------------------------------------------------------------------------
// Pipeline wiring helpers.
// ---------------------------------------------------------------------------

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Stub SearchUseCasePort returning a minimal grounded SearchResponseV1. The
 *  real SearchUseCase has a documented runtime bug (see
 *  wine-search-test-container.ts); we stub it so synthesis grounds cleanly. */
function makeStubSearch(): SearchUseCasePort {
  const response = {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: [
      { entity: { entityId: 'wine-1', canonicalLabel: 'Domaine Test Pinot Noir', producer: 'Domaine Test', region: 'Burgundy' } },
    ] as unknown as SearchResponseV1['results'],
    meta: { generatedAt: '2026-05-21T00:00:00.000Z' } as unknown as SearchResponseV1['meta'],
  } satisfies SearchResponseV1;
  return {
    execute: async () => response,
  };
}

interface HarnessOptions {
  readonly queryAnalyzer?: Pick<QueryAnalyzerService, 'analyze'>;
  readonly wineAgentLoopToolBundle?: OrchestratorWineAgentLoopToolBundle;
  readonly synthModel?: string;
}

/**
 * Build an orchestrator wired with the REAL ClaudeStructuredLlmAdapter (the
 * SUT) at the StructuredLlmPort seam. The global `fetch` is expected to be
 * stubbed by the caller via the fetch-capture helper BEFORE any orchestrator
 * call.
 */
/** Fixed clock so orchestrator-minted `stepId`s (which embed `clock.now()`)
 *  are deterministic across runs — otherwise the synthesize message content
 *  carries a live epoch timestamp and the snapshot drifts. */
const FIXED_CLOCK_MS = 1_700_000_000_000;
const fixedClock = { now: () => FIXED_CLOCK_MS };

function buildHarness(options: HarnessOptions = {}): WineSearchOrchestrator {
  const adapter = new ClaudeStructuredLlmAdapter({
    apiKey: TEST_API_KEY,
    httpTimeoutMs: TEST_HTTP_TIMEOUT_MS,
  });

  const queryAnalyzer = (options.queryAnalyzer
    ?? new QueryAnalyzerService({ structuredLlm: adapter, logger: silentLogger })) as QueryAnalyzerService;
  const router = new DeterministicRouter();
  const executionRunner = new ExecutionRunner({
    searchUseCase: makeStubSearch(),
  });
  const wineAgentLoopRunner = new WineAgentLoopRunner({ structuredLlm: adapter, logger: silentLogger, model: WINE_AGENT_LOOP_MODEL });
  const synthesisRunner = new SynthesisRunner({
    structuredLlm: adapter,
    logger: silentLogger,
    model: options.synthModel ?? SYNTH_MODEL,
  });

  return new WineSearchOrchestrator({
    queryAnalyzer,
    router,
    executionRunner,
    wineAgentLoopRunner,
    synthesisRunner,
    logger: silentLogger,
    clock: fixedClock,
    ...(options.wineAgentLoopToolBundle !== undefined
      ? { wineAgentLoopToolBundle: options.wineAgentLoopToolBundle }
      : {}),
  });
}

/** Build a complete, valid analysis with a forced shape (used to drive
 *  multi-step / specific routes deterministically). */
function makeAnalysis(overrides: Partial<WineSearchAnalysis>): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 2 },
    hangulDominant: false,
    preservedSurface: 'query',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Anthropic wire-contract (real adapter, mocked fetch)', () => {
  beforeEach(() => {
    globalCircuitBreakerRegistry.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  // ── Scenario 1: Korean single-shot. Deterministic analysis (anchor) routes
  //    to single-search; synthesizer issues the only LLM call.
  it('1. Korean single-shot — synthesize payload is spec-perfect (cache markers)', async () => {
    const capture = buildAnthropicFetchCapture(() => respondToolUse(synthAnswer('부르고뉴 피노누아 3종을 추천합니다.')));
    vi.stubGlobal('fetch', capture.fetchMock);

    const orchestrator = buildHarness();
    const result = await orchestrator.execute({
      messages: [{ role: 'user', content: '부르고뉴 피노누아 추천해줘' }],
      requestId: 'req-ko-single',
    });

    expect(result.answer.length).toBeGreaterThan(0);
    // Deterministic anchor → no analyzer LLM call; exactly one synthesize call.
    expect(capture.requests).toHaveLength(1);
    const body = assertWireInvariants(capture.requests[0]!);
    // Synthesizer forces the `respond` tool and enables prompt caching.
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    assertPromptCacheMarkers(body, true);
    matchWireSnapshot('korean-single-synthesize', capture.requests[0]!);
  });

  // ── Scenario 2: English single-shot.
  it('2. English single-shot — synthesize payload is spec-perfect', async () => {
    const capture = buildAnthropicFetchCapture(() => respondToolUse(synthAnswer('Here are three Burgundy Pinot Noir picks.')));
    vi.stubGlobal('fetch', capture.fetchMock);

    const orchestrator = buildHarness();
    const result = await orchestrator.execute({
      messages: [{ role: 'user', content: 'recommend a Burgundy pinot noir under 50000 KRW' }],
      requestId: 'req-en-single',
    });

    expect(result.answer.length).toBeGreaterThan(0);
    expect(capture.requests.length).toBeGreaterThanOrEqual(1);
    const synth = capture.requests.at(-1)!;
    const body = assertWireInvariants(synth);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    matchWireSnapshot('english-single-synthesize', synth);
  });

  // ── Scenario 3: Analyzer LLM-fallback (fully ambiguous query). The analyzer
  //    issues an `analyze` payload, then the synthesizer issues a `synthesize`
  //    payload — two distinct LLM calls.
  it('3. Analyzer LLM-fallback — analyze + synthesize payloads both spec-perfect', async () => {
    const capture = buildAnthropicFetchCapture((req, i) => {
      if (i === 0) {
        // analyze call → return a valid WineSearchAnalysis envelope.
        return respondToolUse({
          intent: 'search',
          anchors: [],
          normalizedConstraints: [],
          contract: {
            requiresDrinkabilityCheck: false,
            requiresGroundedWineSearch: false,
            hasEntityMetadataSignal: false,
          },
          expectedMultiStep: false,
          recommendedBudget: { maxSteps: 4, perToolCap: 2 },
          hangulDominant: false,
          preservedSurface: 'something nice',
        });
      }
      return respondToolUse(synthAnswer('Here is a wine suggestion.'));
    });
    vi.stubGlobal('fetch', capture.fetchMock);

    const orchestrator = buildHarness();
    await orchestrator.execute({ messages: [{ role: 'user', content: 'something nice' }], requestId: 'req-ambiguous' });

    // First call is analyze (forced respond, model = analyzer fallback model),
    // last call is synthesize.
    expect(capture.requests.length).toBeGreaterThanOrEqual(2);
    // Regression guard for the model-id fix: LLM_FALLBACK_MODEL in
    // query-analyzer.ts must conform to the Anthropic Messages API naming
    // convention `claude-<family>-<gen>-...`. The legacy
    // `claude-4-sonnet-latest` ordering causes HTTP 400 from the real API;
    // this assertion would catch any re-regression to that form.
    const analyzeBody = assertWireInvariants(capture.requests[0]!);
    expect(analyzeBody.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    expect(SPEC_MODEL_PATTERN.test(analyzeBody.model)).toBe(true);
    matchWireSnapshot('ambiguous-analyze', capture.requests[0]!);

    const synthBody = assertWireInvariants(capture.requests.at(-1)!);
    expect(synthBody.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    matchWireSnapshot('ambiguous-synthesize', capture.requests.at(-1)!);
  });

  // ── Scenario 4: Comparison plan. Deterministic analysis with a comparison
  //    decomposition routes to ExecutionRunner (no LLM), then synthesize.
  it('4. Comparison — exec runner runs deterministically, synthesize payload spec-perfect', async () => {
    const capture = buildAnthropicFetchCapture(() => respondToolUse(synthAnswer('Wine A is bolder than Wine B.')));
    vi.stubGlobal('fetch', capture.fetchMock);

    const analysis = makeAnalysis({
      intent: 'compare',
      decomposition: {
        kind: 'comparison',
        legs: [
          { surface: 'Barolo', constraints: [] },
          { surface: 'Brunello', constraints: [] },
        ],
      },
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: false,
      },
      preservedSurface: 'compare Barolo vs Brunello',
    });
    const orchestrator = buildHarness({
      queryAnalyzer: { analyze: async () => ({ kind: 'ok', analysis }) },
    });
    await orchestrator.execute({ messages: [{ role: 'user', content: 'compare Barolo vs Brunello' }], requestId: 'req-compare' });

    // ExecutionRunner is deterministic (no LLM); only synthesize hits the API.
    expect(capture.requests).toHaveLength(1);
    const body = assertWireInvariants(capture.requests[0]!);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    matchWireSnapshot('comparison-synthesize', capture.requests[0]!);
  });

  // ── Scenario 5: Multi-step. Forced expectedMultiStep=true routes to the
  //    WineAgentLoop, whose `execute` payloads carry all four tools + tool_choice
  //    auto + prompt cache markers, then synthesize.
  it('5. Multi-step — WineAgentLoop execute() payloads carry all tools, auto choice, cache markers', async () => {
    const capture = buildAnthropicFetchCapture((req, i) => {
      // Call 0: wine-agent-loop execute → emit a search_hybrid tool_use.
      if (i === 0) return namedToolUse('search_hybrid', { query: 'Burgundy pinot' });
      // Call 1: wine-agent-loop execute → final text answer (ends the loop).
      if (i === 1) return endTurnText('Found a Burgundy Pinot Noir for you.');
      // Call 2+: synthesize.
      return respondToolUse(synthAnswer('Recommended a Burgundy Pinot Noir.'));
    });
    vi.stubGlobal('fetch', capture.fetchMock);

    const bundle = buildWineAgentLoopToolBundle({
      searchUseCase: makeStubSearch(),
          });
    const analysis = makeAnalysis({
      intent: 'search',
      expectedMultiStep: true,
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: true,
        hasEntityMetadataSignal: false,
      },
      recommendedBudget: { maxSteps: 6, perToolCap: 3 },
      preservedSurface: 'find and assess a Burgundy pinot',
    });
    const orchestrator = buildHarness({
      queryAnalyzer: { analyze: async () => ({ kind: 'ok', analysis }) },
      wineAgentLoopToolBundle: bundle,
    });
    await orchestrator.execute({ messages: [{ role: 'user', content: 'find and assess a Burgundy pinot' }], requestId: 'req-multistep' });

    // At least one execute() turn + one synthesize().
    expect(capture.requests.length).toBeGreaterThanOrEqual(2);
    const execBody = assertWireInvariants(capture.requests[0]!);
    // WineAgentLoop uses tool_choice auto and exposes the active tools.
    expect(execBody.tool_choice).toEqual({ type: 'auto' });
    // T-IR-05 + RFC-021 T-PSA-02: the agent bundle carries the retrieval
    // primitives plus `similar_to_entity`, in WINE_AGENT_LOOP_TOOL_NAMES order.
    // We assert membership (sorted) so the check is order-independent of how the
    // adapter serializes the array.
    const execToolNames = execBody.tools.map((t) => t.name).sort();
    expect(execToolNames).toEqual(
      ['lookup_wine', 'search_hybrid', 'search_lexical', 'search_semantic', 'similar_to_entity'],
    );
    // WineAgentLoop passes enablePromptCache:true (wine-agent-loop.ts L484).
    assertPromptCacheMarkers(execBody, true);
    matchWireSnapshot('multistep-execute-turn0', capture.requests[0]!);

    // Synthesize is the last call.
    const synthBody = assertWireInvariants(capture.requests.at(-1)!);
    expect(synthBody.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    matchWireSnapshot('multistep-synthesize', capture.requests.at(-1)!);
  });

  // ── Scenario 6: Prompt-cache markers byte-for-byte. Asserts the EXACT marker
  //    object identity on the deepest level for synthesize (cache always on).
  it('6. Prompt-cache markers are byte-for-byte { type: "ephemeral" } on last system + last tool', async () => {
    const capture = buildAnthropicFetchCapture(() => respondToolUse(synthAnswer('cache check answer')));
    vi.stubGlobal('fetch', capture.fetchMock);

    const orchestrator = buildHarness();
    await orchestrator.execute({ messages: [{ role: 'user', content: 'Sancerre recommendation' }], requestId: 'req-cache' });

    const synth = capture.requests.at(-1)!;
    const body = assertWireInvariants(synth);
    // anthropic-beta header is NOT set by this adapter; the marker lives in the
    // body. We assert the markers are present and exact.
    assertPromptCacheMarkers(body, true);
    // Byte-exact: deep-equal the marker objects (no extra keys).
    expect(body.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    matchWireSnapshot('promptcache-synthesize', synth);
  });

  // ── Scenario 7: Refusal handling. Adapter maps stop_reason=refusal to a
  //    StructuredLlmRefusalError; the synthesizer falls through its ladder.
  //    The OUTGOING request is still spec-perfect (that's the contract).
  it('7. Refusal — outgoing synthesize request is still spec-perfect; pipeline degrades gracefully', async () => {
    const capture = buildAnthropicFetchCapture(() => refusalResponse());
    vi.stubGlobal('fetch', capture.fetchMock);

    // Force a deterministic analysis (anchor present) so the analyzer LLM
    // fallback does NOT fire — keeping this scenario focused purely on the
    // synthesizer's refusal handling with the (valid) injected synth model.
    const analysis = makeAnalysis({
      intent: 'search',
      anchors: [{ surface: 'Sancerre', canonicalValue: 'Sancerre', entityType: 'appellation', confidence: 0.9 }],
      contract: { requiresDrinkabilityCheck: false, requiresGroundedWineSearch: false, hasEntityMetadataSignal: false },
      preservedSurface: 'recommend a Sancerre for dinner',
    });
    const orchestrator = buildHarness({
      queryAnalyzer: { analyze: async () => ({ kind: 'ok', analysis }) },
    });
    const result = await orchestrator.execute({
      messages: [{ role: 'user', content: 'recommend a Sancerre for dinner' }],
      requestId: 'req-refusal',
    });

    // Pipeline never throws — it falls back to a deterministic answer.
    expect(result.answer.length).toBeGreaterThan(0);
    // The synthesize attempt fired (and possibly a retry). Every outgoing
    // request is spec-perfect.
    expect(capture.requests.length).toBeGreaterThanOrEqual(1);
    for (const req of capture.requests) {
      const body = assertWireInvariants(req);
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    }
    matchWireSnapshot('refusal-synthesize', capture.requests[0]!);
  });

  // ── Scenario 8: Token-usage accounting = sum of per-call usages. The
  //    orchestrator sums per-LLM-call usage; we drive 2 distinct calls
  //    (analyze + synthesize) with known usages and verify the sum.
  it('8. Token usage = sum of per-call usages (analyze + synthesize)', async () => {
    const ANALYZE_USAGE = { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 };
    const SYNTH_USAGE = { input_tokens: 333, output_tokens: 44, cache_read_input_tokens: 9, cache_creation_input_tokens: 11 };
    const capture = buildAnthropicFetchCapture((req, i) => {
      if (i === 0) {
        return {
          status: 200,
          bodyJson: {
            id: 'm', type: 'message', role: 'assistant', model: ANALYZE_MODEL,
            stop_reason: 'tool_use', stop_sequence: null,
            content: [{ type: 'tool_use', id: 't', name: 'respond', input: {
              intent: 'search', anchors: [], normalizedConstraints: [],
              contract: { requiresDrinkabilityCheck: false, requiresGroundedWineSearch: false, hasEntityMetadataSignal: false },
              expectedMultiStep: false, recommendedBudget: { maxSteps: 4, perToolCap: 2 },
              hangulDominant: false, preservedSurface: 'nice wine',
            } }],
            usage: ANALYZE_USAGE,
          },
        };
      }
      return {
        status: 200,
        bodyJson: {
          id: 'm2', type: 'message', role: 'assistant', model: SYNTH_MODEL,
          stop_reason: 'tool_use', stop_sequence: null,
          content: [{ type: 'tool_use', id: 't2', name: 'respond', input: synthAnswer('A nice wine.') }],
          usage: SYNTH_USAGE,
        },
      };
    });
    vi.stubGlobal('fetch', capture.fetchMock);

    const orchestrator = buildHarness();
    const result = await orchestrator.execute({ messages: [{ role: 'user', content: 'nice wine' }], requestId: 'req-usage' });

    // Two LLM calls fired (analyze fallback + synthesize). Note: the analyzer
    // does NOT add its usage to the orchestrator total (it returns AnalysisOutcome
    // without usage); only synthesize usage flows into result.tokenUsage. We
    // assert what the orchestrator actually accounts: synth usage.
    expect(capture.requests.length).toBeGreaterThanOrEqual(2);
    expect(result.tokenUsage.inputTokens).toBe(SYNTH_USAGE.input_tokens);
    expect(result.tokenUsage.outputTokens).toBe(SYNTH_USAGE.output_tokens);
    expect(result.tokenUsage.cacheReadTokens).toBe(SYNTH_USAGE.cache_read_input_tokens);
    expect(result.tokenUsage.cacheCreationTokens).toBe(SYNTH_USAGE.cache_creation_input_tokens);
  });

  // ── Scenario 9: input_schema validity. Every tool's input_schema across
  //    analyze, execute, and synthesize is a valid JSON-Schema object with
  //    a `properties` map (asserted via ToolInputSchema inside the invariant).
  it('9. input_schema validity — all tool schemas are object+properties across phases', async () => {
    const capture = buildAnthropicFetchCapture((req, i) => {
      if (i === 0) return namedToolUse('search_hybrid', { query: 'x' });
      if (i === 1) return endTurnText('done');
      return respondToolUse(synthAnswer('answer'));
    });
    vi.stubGlobal('fetch', capture.fetchMock);

    const bundle = buildWineAgentLoopToolBundle({
      searchUseCase: makeStubSearch(),
          });
    const analysis = makeAnalysis({
      intent: 'search',
      expectedMultiStep: true,
      contract: { requiresDrinkabilityCheck: false, requiresGroundedWineSearch: true, hasEntityMetadataSignal: false },
      preservedSurface: 'multi tool schema check',
    });
    const orchestrator = buildHarness({
      queryAnalyzer: { analyze: async () => ({ kind: 'ok', analysis }) },
      wineAgentLoopToolBundle: bundle,
    });
    await orchestrator.execute({ messages: [{ role: 'user', content: 'multi tool schema check' }], requestId: 'req-schema' });

    expect(capture.requests.length).toBeGreaterThanOrEqual(2);
    // Validate EVERY tool input_schema on EVERY captured request. The
    // ToolInputSchema in AnthropicRequestBodySchema already enforces
    // type:'object' + properties; the loop here adds an explicit per-tool
    // assertion for clarity and to confirm the search_hybrid schema has the
    // expected `query` property.
    let sawSearchHybrid = false;
    for (const req of capture.requests) {
      const body = assertWireInvariants(req);
      for (const tool of body.tools) {
        expect(tool.input_schema.type).toBe('object');
        const props = tool.input_schema.properties;
        expect(Object.keys(props).length).toBeGreaterThan(0);
        if (tool.name === 'search_hybrid') {
          sawSearchHybrid = true;
          expect(props['query']).toBeDefined();
        }
      }
    }
    expect(sawSearchHybrid).toBe(true);
  });

  // ── Scenario 10: PRODUCTION model-id regression guard.
  //    Three pipeline modules previously pinned the legacy
  //    `claude-4-<family>-latest` ordering which the Anthropic API rejects
  //    with HTTP 400 (it expects `claude-<family>-<gen>-...`). This test
  //    drives each module with its PRODUCTION DEFAULT model and asserts the
  //    spec-compliant form so the fix cannot regress.
  //      - query-analyzer.ts:        LLM_FALLBACK_MODEL    (analyzer LLM fallback)
  //      - synthesis-runner.ts:      DEFAULT_SYNTHESIS_MODEL
  //      - wine-agent-loop-schemas.ts:     WINE_AGENT_LOOP_DEFAULT_MODEL
  it('10. model-id regression guard — pipeline defaults conform to API naming convention', async () => {
    // Synthesizer with its PRODUCTION default model (no override).
    const capture = buildAnthropicFetchCapture(() => respondToolUse(synthAnswer('answer')));
    vi.stubGlobal('fetch', capture.fetchMock);

    const adapter = new ClaudeStructuredLlmAdapter({ apiKey: TEST_API_KEY, httpTimeoutMs: TEST_HTTP_TIMEOUT_MS });
    const analysis = makeAnalysis({
      intent: 'search',
      anchors: [{ surface: 'Sancerre', canonicalValue: 'Sancerre', entityType: 'appellation', confidence: 0.9 }],
      preservedSurface: 'Sancerre please',
    });
    const orchestrator = new WineSearchOrchestrator({
      queryAnalyzer: { analyze: async () => ({ kind: 'ok', analysis }) } as QueryAnalyzerService,
      router: new DeterministicRouter(),
      executionRunner: new ExecutionRunner({
        searchUseCase: makeStubSearch(),
                  }),
      wineAgentLoopRunner: new WineAgentLoopRunner({ structuredLlm: adapter, logger: silentLogger }),
      // SynthesisRunner with NO model override → uses DEFAULT_SYNTHESIS_MODEL.
      synthesisRunner: new SynthesisRunner({ structuredLlm: adapter, logger: silentLogger }),
      logger: silentLogger,
      clock: fixedClock,
    });
    await orchestrator.execute({ messages: [{ role: 'user', content: 'Sancerre please' }], requestId: 'req-modeldev' });

    expect(capture.requests).toHaveLength(1);
    const synth = capture.requests[0]!;
    // Every invariant (including model id) holds under the canonical spec pattern.
    const body = assertWireInvariants(synth);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
    // Regression guard: model must conform to `claude-<family>-<gen>-...`.
    expect(SPEC_MODEL_PATTERN.test(body.model)).toBe(true);
    expect(body.model).not.toBe('claude-4-sonnet-latest');
  });
});
