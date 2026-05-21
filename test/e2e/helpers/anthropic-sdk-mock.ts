/**
 * StructuredLlmPort mock for e2e tests (no Anthropic SDK / no fetch).
 *
 * The legacy `ClaudeStructuredLlmAdapter` is the SINGLE seam in the
 * Plan-then-Execute stack that talks to `api.anthropic.com` over fetch. By
 * substituting a `StructuredLlmPort` implementation at the orchestrator's
 * dependency-injection boundary, we:
 *
 *  - keep every other component (`QueryAnalyzerService`,
 *    `DeterministicRouter`, `ExecutionRunner`, `SynthesisRunner`, `MiniLoopRunner`)
 *    running for real,
 *  - bypass `api.anthropic.com` entirely (HERMETIC tests, no env vars, no
 *    `process.env.ANTHROPIC_API_KEY` plumbing required),
 *  - script deterministic responses per phase (`analyze` / `execute` /
 *    `synthesize`) so we can exercise specific code paths,
 *  - record every call so tests can assert the abort signal was propagated.
 *
 * The file is named `anthropic-sdk-mock.ts` to match the test task's vocabulary,
 * but the mock substitutes the entire `StructuredLlmPort` adapter — not a
 * lower-level HTTP/fetch shim. This is the cleaner seam: avoids JSON-Schema
 * round-trip artifacts of the real adapter, and the assertion surface is the
 * port contract (already validated by Zod elsewhere).
 */

import { vi } from 'vitest';
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
} from '../../../src/domain/ai/port/structured-llm.port.js';
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
} from '../../../src/domain/ai/port/structured-llm.port.js';
import type { SynthesisAnswer } from '../../../src/application/wine-search/synthesis-schemas.js';

// ---------------------------------------------------------------------------
// Named constants — keep magic numbers out of test fixtures (CLAUDE.md rule 15).
// ---------------------------------------------------------------------------

/** Default analyze input token count used by the mock unless overridden by
 *  the caller. Sized like a typical Anthropic analyze response footprint. */
export const MOCK_ANALYZE_INPUT_TOKENS = 120;
/** Default analyze output token count. */
export const MOCK_ANALYZE_OUTPUT_TOKENS = 40;
/** Default synthesize input token count. */
export const MOCK_SYNTHESIZE_INPUT_TOKENS = 200;
/** Default synthesize output token count. */
export const MOCK_SYNTHESIZE_OUTPUT_TOKENS = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A scripted `synthesize` response. The mock returns this raw payload — the
 *  consumer (the synthesis-runner) validates it against the synth schema, so
 *  callers must supply a valid `SynthesisAnswer` shape. */
export interface SynthesizeMockOutcome {
  readonly answer: SynthesisAnswer;
  readonly usage?: TokenUsage;
}

/** A scripted `analyze` response. The synth-runner / orchestrator does NOT
 *  call `analyze` for queries with deterministic signal — the analyzer
 *  short-circuits before the LLM. Provide this only when intentionally
 *  exercising the LLM-fallback branch. */
export interface AnalyzeMockOutcome<T = unknown> {
  readonly data: T;
  readonly usage?: TokenUsage;
}

export interface StructuredLlmMockOptions {
  /**
   * Synthesize handler. The orchestrator ALWAYS calls `synthesize` on the
   * non-aborted, non-admit-rejected path. If you omit this, the mock returns
   * a generic Korean answer; tests that care about the synthesized text MUST
   * supply this.
   */
  readonly synthesize?:
    | SynthesizeMockOutcome
    | ((req: SynthesizeRequest<z.ZodTypeAny>) => SynthesizeMockOutcome | Promise<SynthesizeMockOutcome>);
  /**
   * Analyze handler. Only invoked when the deterministic analyzer finds zero
   * signal (no anchors, no constraints, intent=unknown). Most test queries
   * exercise the deterministic path; supply this only when intentionally
   * exercising the LLM fallback. When omitted and the LLM fallback fires, the
   * mock returns a minimal "unknown intent" envelope so the analyzer can
   * proceed.
   */
  readonly analyze?:
    | AnalyzeMockOutcome
    | ((req: AnalyzeRequest<z.ZodTypeAny>) => AnalyzeMockOutcome | Promise<AnalyzeMockOutcome>);
  /**
   * Execute handler — only used by the mini-loop multi-step branch. Omitted
   * by default because none of the e2e scenarios exercise multi-step plans
   * (those require a `miniLoopToolBundle` we do not wire).
   */
  readonly execute?: (req: ExecuteRequest) => ExecuteResult | Promise<ExecuteResult>;
}

export interface StructuredLlmMock extends StructuredLlmPort {
  /** vi.fn record of every `analyze` call. */
  readonly analyzeMock: ReturnType<typeof vi.fn>;
  /** vi.fn record of every `execute` call. */
  readonly executeMock: ReturnType<typeof vi.fn>;
  /** vi.fn record of every `synthesize` call. */
  readonly synthesizeMock: ReturnType<typeof vi.fn>;
  /** Snapshot of every AbortSignal the mock observed. Useful for asserting
   *  the orchestrator cleaned up after a client abort. */
  readonly observedAbortSignals: AbortSignal[];
}

// ---------------------------------------------------------------------------
// Default outcomes
// ---------------------------------------------------------------------------

const DEFAULT_KOREAN_SYNTH_ANSWER = '추천 결과를 정리했습니다. 적합한 옵션 3종을 확인해주세요.';
const DEFAULT_ENGLISH_SYNTH_ANSWER = 'Here are three wine recommendations matching your query.';

function defaultZeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function defaultSynthesizeOutcome(req: SynthesizeRequest<z.ZodTypeAny>): SynthesizeMockOutcome {
  // Heuristic: if the request's user message carries Korean Hangul, return
  // a Korean answer; otherwise English. Used only when callers do not pass
  // an explicit `synthesize` outcome. We INTENTIONALLY do not import the
  // production `containsHangul` helper to keep the mock self-contained
  // (rule 25 applies to PRODUCTION vocabulary, not test fixtures).
  const text = req.messages.map((m) => m.content).join(' ');
  const hasHangul = /[가-힯]/u.test(text);
  return {
    answer: {
      answer: hasHangul ? DEFAULT_KOREAN_SYNTH_ANSWER : DEFAULT_ENGLISH_SYNTH_ANSWER,
      citations: ['wine-1'],
    },
    usage: {
      inputTokens: MOCK_SYNTHESIZE_INPUT_TOKENS,
      outputTokens: MOCK_SYNTHESIZE_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a vitest-friendly `StructuredLlmPort` mock that returns scripted
 * responses for `analyze` / `execute` / `synthesize`.
 *
 * Each call snapshots its `abortSignal` into `observedAbortSignals` BEFORE
 * resolving the response, so tests can assert that the orchestrator wired
 * its signal correctly (without racing against the abort propagation).
 */
export function buildStructuredLlmMock(options: StructuredLlmMockOptions = {}): StructuredLlmMock {
  const observedAbortSignals: AbortSignal[] = [];

  const analyzeMock = vi.fn(async (req: AnalyzeRequest<z.ZodTypeAny>): Promise<AnalyzeResult<unknown>> => {
    if (req.abortSignal !== undefined) observedAbortSignals.push(req.abortSignal);
    const usage: TokenUsage = {
      inputTokens: MOCK_ANALYZE_INPUT_TOKENS,
      outputTokens: MOCK_ANALYZE_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    if (options.analyze === undefined) {
      // No scripted response — return a minimal "unknown intent" envelope so
      // the analyzer's `WineSearchAnalysisSchema.safeParse` succeeds.
      const fallback = {
        intent: 'unknown',
        anchors: [],
        normalizedConstraints: [],
        contract: {
          requiresDrinkabilityCheck: false,
          requiresGroundedWineSearch: false,
          hasEntityMetadataSignal: false,
        },
        expectedMultiStep: false,
        recommendedBudget: { maxSteps: 1, perToolCap: 2 },
        hangulDominant: false,
        preservedSurface: req.query,
      };
      return { data: fallback, usage, durationMs: 1 };
    }
    const outcome = typeof options.analyze === 'function'
      ? await options.analyze(req)
      : options.analyze;
    return { data: outcome.data, usage: outcome.usage ?? usage, durationMs: 1 };
  });

  const executeMock = vi.fn(async (req: ExecuteRequest): Promise<ExecuteResult> => {
    if (req.abortSignal !== undefined) observedAbortSignals.push(req.abortSignal);
    if (options.execute === undefined) {
      // No scripted response — return a benign end-of-turn so the mini-loop
      // exits gracefully if some test path reaches it unexpectedly.
      return {
        kind: 'text',
        text: 'no-op',
        usage: defaultZeroUsage(),
        durationMs: 1,
        stopReason: 'end_turn',
      };
    }
    return options.execute(req);
  });

  const synthesizeMock = vi.fn(async (req: SynthesizeRequest<z.ZodTypeAny>): Promise<SynthesizeResult<unknown>> => {
    if (req.abortSignal !== undefined) observedAbortSignals.push(req.abortSignal);
    const outcome = options.synthesize === undefined
      ? defaultSynthesizeOutcome(req)
      : typeof options.synthesize === 'function'
        ? await options.synthesize(req)
        : options.synthesize;
    const usage = outcome.usage ?? {
      inputTokens: MOCK_SYNTHESIZE_INPUT_TOKENS,
      outputTokens: MOCK_SYNTHESIZE_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    return { data: outcome.answer, usage, durationMs: 1 };
  });

  return {
    analyzeMock,
    executeMock,
    synthesizeMock,
    observedAbortSignals,
    analyze: analyzeMock as unknown as StructuredLlmPort['analyze'],
    execute: executeMock as unknown as StructuredLlmPort['execute'],
    synthesize: synthesizeMock as unknown as StructuredLlmPort['synthesize'],
  };
}

// ---------------------------------------------------------------------------
// Inspection helpers (additive — used by adversarial e2e tests)
// ---------------------------------------------------------------------------

/**
 * Extract the system prompt the synthesizer would have sent to the LLM on its
 * most recent call. Returns `undefined` if `synthesize` was never invoked.
 * Tests use this to assert that user-supplied content (e.g. an injection
 * attempt) was NOT smuggled into the `systemPrompt` slot — which would grant
 * it elevated privilege over the wine-domain hard rules.
 */
export function getLastSynthesizeSystemPrompt(mock: StructuredLlmMock): string | undefined {
  const lastCall = mock.synthesizeMock.mock.calls.at(-1);
  if (lastCall === undefined) return undefined;
  const req = lastCall[0] as SynthesizeRequest<z.ZodTypeAny> | undefined;
  return req?.systemPrompt;
}

/**
 * Extract the concatenated `messages[*].content` the synthesizer received on
 * its most recent call. Tests use this to assert that injection payloads
 * appear ONLY in user-role message content (where they are unprivileged),
 * never in the system prompt.
 */
export function getLastSynthesizeUserContent(mock: StructuredLlmMock): string | undefined {
  const lastCall = mock.synthesizeMock.mock.calls.at(-1);
  if (lastCall === undefined) return undefined;
  const req = lastCall[0] as SynthesizeRequest<z.ZodTypeAny> | undefined;
  if (req === undefined) return undefined;
  return req.messages.map((m) => m.content).join('\n');
}

// ---------------------------------------------------------------------------
// Failure-injection helpers — ADDITIVE. Used by the
// `wine-search-api-hell-pipeline.test.ts` suite to exercise the orchestrator's
// 4-layer fallback ladder against the 5 documented `StructuredLlmPort` error
// classes plus the generic / abort cases.
//
// These helpers return `StructuredLlmMockOptions` shapes (callable handlers)
// so callers can drop them straight into `buildWineSearchTestContainer({
// llmMock: ... })`. We deliberately do NOT modify the test container helper —
// the existing `synthesize: (req) => {...}` / `analyze: (req) => {...}` /
// `execute: (req) => {...}` function-handler hooks already propagate thrown
// exceptions because `buildStructuredLlmMock` calls them inside the
// `vi.fn(async ...)` body. Failure injection is therefore purely additive
// here.
// ---------------------------------------------------------------------------

/** Discriminated identifier for the kind of error to inject. Mirrors the
 *  classes exported from `structured-llm.port.ts` plus the generic `Error`
 *  case (which the orchestrator must NOT let bubble out as a 500). */
export type StructuredLlmInjectedErrorClass =
  | 'validation'
  | 'refusal'
  | 'partial'
  | 'timeout'
  | 'circuit_open'
  | 'generic';

/** Which phase of the pipeline the injected failure should fire on. */
export type StructuredLlmInjectedPhase = 'analyze' | 'execute' | 'synthesize';

function makeInjectedError(klass: StructuredLlmInjectedErrorClass): Error {
  switch (klass) {
    case 'validation':
      return new StructuredLlmValidationError([], { raw: 'injected' }, 'injected-validation');
    case 'refusal':
      return new StructuredLlmRefusalError('injected-refusal');
    case 'partial':
      return new StructuredLlmPartialOutputError({ raw: 'truncated' }, 'injected-partial');
    case 'timeout':
      return new StructuredLlmTimeoutError('injected-timeout');
    case 'circuit_open':
      return new StructuredLlmCircuitOpenError('synthesis', 'injected-circuit-open');
    case 'generic':
      return new Error('injected-generic-error');
  }
}

/**
 * Build LLM mock-options whose chosen phase throws the given typed error on
 * EVERY call. All other phases use the mock factory's default behavior.
 *
 * Drop the result into `buildWineSearchTestContainer({ llmMock: ... })`. The
 * existing function-handler hooks (`options.synthesize`, `options.analyze`,
 * `options.execute`) propagate thrown exceptions because the inner `vi.fn`
 * body awaits them — failure injection is therefore purely additive.
 */
export function makeStructuredLlmThatThrows(
  errorClass: StructuredLlmInjectedErrorClass,
  phase: StructuredLlmInjectedPhase = 'synthesize',
): StructuredLlmMockOptions {
  if (phase === 'analyze') {
    return {
      analyze: (_req: AnalyzeRequest<z.ZodTypeAny>): AnalyzeMockOutcome => {
        throw makeInjectedError(errorClass);
      },
    };
  }
  if (phase === 'execute') {
    return {
      execute: (_req: ExecuteRequest): ExecuteResult => {
        throw makeInjectedError(errorClass);
      },
    };
  }
  return {
    synthesize: (_req: SynthesizeRequest<z.ZodTypeAny>): SynthesizeMockOutcome => {
      throw makeInjectedError(errorClass);
    },
  };
}

/** Per-call response in a scripted sequence. Either yields a SynthesizeMockOutcome
 *  (success) or throws a typed error class. Order is consumed on the synthesize
 *  phase only — analyze and execute keep their default behavior. */
export type StructuredLlmMockResponse =
  | { readonly kind: 'ok'; readonly outcome: SynthesizeMockOutcome }
  | { readonly kind: 'throw'; readonly errorClass: StructuredLlmInjectedErrorClass };

/**
 * Build LLM mock-options whose `synthesize` returns the nth scripted response
 * on the nth invocation. Once the script is exhausted, subsequent calls throw
 * a generic `Error` (this surfaces the "ran out of script" case as a loud
 * failure in tests rather than a silent loop).
 *
 * Useful for layer-ladder tests: first call throws Validation, second call
 * returns a valid answer to verify the retry path; first+second throw to
 * verify Layer 2/3/4 fall-through. The synthesizer makes at most 2 attempts
 * (primary + one retry) before falling through to the deterministic ladder,
 * so scripts of length > 2 are wasted — keep them short.
 */
export function makeStructuredLlmWithSequence(
  responses: readonly StructuredLlmMockResponse[],
): StructuredLlmMockOptions {
  let i = 0;
  return {
    synthesize: (_req: SynthesizeRequest<z.ZodTypeAny>): SynthesizeMockOutcome => {
      const step = responses[i];
      i += 1;
      if (step === undefined) {
        throw new Error('makeStructuredLlmWithSequence: script exhausted');
      }
      if (step.kind === 'throw') {
        throw makeInjectedError(step.errorClass);
      }
      return step.outcome;
    },
  };
}

// ---------------------------------------------------------------------------
// Concurrency-test helpers (additive — used by
// `wine-search-api-hell-concurrency.test.ts`). All builders return a
// `StructuredLlmMockOptions` shape so they compose with
// `buildWineSearchTestContainer({ llmMock: ... })` without touching the
// container helper.
// ---------------------------------------------------------------------------

/**
 * Build a `synthesize` handler that ECHOES BACK a per-request marker recovered
 * from the user-role message content via the supplied regex. The marker MUST
 * appear in the original user query so each concurrent request receives a
 * distinct synthesized answer — a precondition for "no cross-talk" assertions.
 *
 * If no marker is found, the handler returns a sentinel answer so the
 * cross-talk check fails LOUDLY rather than silently passing.
 *
 * The handler also captures the abortSignal it saw at the time of invocation
 * via the side-effect closure (`observedSignalsByMarker`). Tests use this to
 * assert per-request signal isolation (each request must see its OWN signal,
 * not a sibling's).
 */
export interface MarkerEchoSynthesizeOptions {
  readonly markerRe: RegExp;
  readonly observedSignalsByMarker: Map<string, AbortSignal>;
  readonly delayMs?: number;
}

export function makeMarkerEchoSynthesize(
  options: MarkerEchoSynthesizeOptions,
): StructuredLlmMockOptions {
  return {
    synthesize: async (req): Promise<SynthesizeMockOutcome> => {
      // Yield to the event loop so concurrent requests genuinely interleave.
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      } else {
        await Promise.resolve();
      }
      const text = req.messages.map((m) => m.content).join('\n');
      const match = options.markerRe.exec(text);
      const marker = match?.[0] ?? 'NO_MARKER';
      if (req.abortSignal !== undefined) {
        options.observedSignalsByMarker.set(marker, req.abortSignal);
      }
      return {
        answer: {
          answer: `synthesized for ${marker}`,
          citations: ['wine-1'],
        },
      };
    },
  };
}

/**
 * Build a `synthesize` handler that records the AbortSignal listener count
 * (best-effort) and the signal identity for every invocation. The
 * `listenerSnapshot` callback is invoked after the signal is observed so the
 * test can probe `listenerCount` on the signal at call time.
 */
export interface ListenerProbeSynthesizeOptions {
  readonly onCall: (req: { abortSignal?: AbortSignal | undefined }) => void;
  readonly delayMs?: number;
}

export function makeListenerProbeSynthesize(
  options: ListenerProbeSynthesizeOptions,
): StructuredLlmMockOptions {
  return {
    synthesize: async (req): Promise<SynthesizeMockOutcome> => {
      options.onCall({ abortSignal: req.abortSignal });
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      } else {
        await Promise.resolve();
      }
      return { answer: { answer: 'ok', citations: ['wine-1'] } };
    },
  };
}

/**
 * Build LLM mock-options whose `synthesize` cooperatively aborts. Two modes:
 *  - `'before_response'`: the mock throws an `AbortError`-shaped exception
 *    immediately on invocation. Mirrors the synthesizer's `throwIfAborted`
 *    early-exit semantics.
 *  - `'mid_response'`: the mock awaits a microtask, then throws an
 *    AbortError-shaped exception so the orchestrator's catch path recognizes
 *    the cancellation via `isAbortError`.
 *
 * Both paths produce an Error whose `name === 'AbortError'` so the shared
 * `isAbortError` helper recognizes it.
 */
export function makeStructuredLlmThatAborts(
  whenSignalAborts: 'before_response' | 'mid_response',
): StructuredLlmMockOptions {
  return {
    synthesize: async (_req: SynthesizeRequest<z.ZodTypeAny>): Promise<SynthesizeMockOutcome> => {
      if (whenSignalAborts === 'mid_response') {
        await Promise.resolve();
      }
      const err = new Error('mock-aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
}
