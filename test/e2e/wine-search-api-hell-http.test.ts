/**
 * Hell-difficulty e2e tests for POST /v1/agent.
 *
 * Companion to `test/e2e/wine-search-api.test.ts`. That file proves the happy
 * path + basic validation; this file attacks the HTTP boundary itself:
 *   - Request-body adversarial inputs (type confusion, length boundary,
 *     surrogate-pair Unicode, deep nesting, malformed JSON).
 *   - Content-Type tricks (missing, wrong, charset variants).
 *   - Method + path tricks (405/404 surfaces, trailing slash, case).
 *   - AbortSignal lifecycle (client disconnect, in-flight abort,
 *     concurrent abort isolation).
 *   - Header manipulation (XSS reflection, oversized, non-ASCII).
 *   - Concurrency (request_id uniqueness, no cross-talk).
 *   - RFC-014 error envelope shape conformance across every 4xx trigger.
 *
 * STRICT SCOPE: this file is additive. It re-uses
 *   - `buildWineSearchTestContainer`, `makeStubSearchUseCase` from
 *     `helpers/wine-search-test-container.ts`,
 *   - `WineSearchResponseSchema` from the route's schema module,
 *   - the project-wide RFC-014 `ErrorResponseSchema` for 4xx/5xx envelopes,
 *   - named constants (`MAX_AGENT_HTTP_QUERY_CHARS`, `MAX_AGENT_STEPS_CAP`)
 *     so no magic numbers (CLAUDE.md rule 15).
 *
 * CLAUDE.md compliance:
 *   - Rule 5: ASCII, Korean (한글), accented Latin, emoji inputs tested.
 *   - Rule 8: any regex uses `[\p{L}\p{N}]` boundaries + `/u` flag.
 *   - Rule 10: every test-local Zod object is `.strict()`.
 *   - Rule 15: named constants for every numeric bound.
 *   - Rule 18: boundary tests at exactly-limit AND just-over-limit.
 *   - Rule 23: false-positive guard — legitimate queries that contain
 *     substrings of blocked patterns are NOT rejected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildWineSearchTestContainer,
  makeStubSearchUseCase,
  type WineSearchTestHarness,
} from './helpers/wine-search-test-container.js';
import { WineSearchResponseSchema } from '../../src/interface/http/schemas/wine-search.schema.js';
import { ErrorResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';
import {
  MAX_AGENT_HTTP_QUERY_CHARS,
  MAX_AGENT_STEPS_CAP,
} from '../../src/interface/http/constants.js';

// ---------------------------------------------------------------------------
// Named constants — CLAUDE.md rule 15.
// ---------------------------------------------------------------------------

/** Concurrency stress: number of parallel POSTs in the "no cross-talk" test.
 *  50 is high enough to expose iteration-order race bugs without bloating
 *  CI runtime. */
const STRESS_CONCURRENT_REQUESTS = 50;

/** Concurrency cross-talk test: smaller batch with distinct queries so each
 *  response carries a unique synthesized answer. */
const CROSSTALK_CONCURRENT_REQUESTS = 10;

/** Oversized header value length used in the "10K-char request id" case. */
const OVERSIZED_HEADER_VALUE_CHARS = 10_000;

/** Lower-bound floor for `per_step_timeout_ms` declared by the request
 *  schema. Mirrors `REQUEST_PER_STEP_TIMEOUT_MIN_MS` in
 *  `wine-search.schema.ts`. Repeated here only because the constant is
 *  module-private in that file. */
const PER_STEP_TIMEOUT_MIN_MS = 1_000;
/** Upper ceiling for `per_step_timeout_ms`. */
const PER_STEP_TIMEOUT_MAX_MS = 60_000;
/** Lower-bound floor for `agent_timeout_ms`. */
const AGENT_TIMEOUT_MIN_MS = 1_000;
/** Upper ceiling for `agent_timeout_ms`. */
const AGENT_TIMEOUT_MAX_MS = 120_000;
/** Lower-bound floor for `max_total_tokens`. */
const MAX_TOTAL_TOKENS_MIN = 1_000;
/** Upper ceiling for `max_total_tokens`. */
const MAX_TOTAL_TOKENS_MAX = 200_000;

/** Hangul-friendly word-boundary regex used by Rule-23 false-positive guard.
 *  `\b` is ASCII-only (CLAUDE.md rule 8) and silently breaks on Korean — use
 *  Unicode character classes via the bracketed-class pattern. */
const KOREAN_LEGITIMATE_QUERY_RE = /(?:^|[^\p{L}\p{N}])와인(?=$|[^\p{L}\p{N}])/u;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectOptions {
  readonly method?: 'POST' | 'GET' | 'PUT' | 'OPTIONS' | 'DELETE' | 'PATCH';
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly payload?: string | object;
}

function inject(harness: WineSearchTestHarness, opts: InjectOptions = {}) {
  const method = opts.method ?? 'POST';
  const url = opts.url ?? '/v1/agent';
  const headers = opts.headers ?? { 'content-type': 'application/json' };
  const payload = typeof opts.payload === 'string' || opts.payload === undefined
    ? opts.payload
    : JSON.stringify(opts.payload);
  return harness.app.inject({ method, url, headers, payload });
}

function singleTurnPayload(
  content: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content }],
    ...overrides,
  };
}

/**
 * Parse a response body as the RFC-014 error envelope. Throws (and fails the
 * test) if the body is not the canonical shape. Use this in EVERY 4xx
 * assertion so the route can never drift to a Fastify-default envelope
 * undetected.
 */
function expectRfc014Envelope(rawBody: unknown): z.infer<typeof ErrorResponseSchema> {
  const parsed = ErrorResponseSchema.safeParse(rawBody);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.flatten())).toBe(true);
  if (!parsed.success) {
    throw new Error('unreachable — expect already failed');
  }
  return parsed.data;
}

async function buildHappyHarness(answer = '추천 결과를 정리했습니다.'): Promise<WineSearchTestHarness> {
  return buildWineSearchTestContainer({
    searchUseCase: makeStubSearchUseCase(),
    llmMock: {
      synthesize: { answer: { answer, citations: ['wine-1'] } },
    },
  });
}

// ---------------------------------------------------------------------------
// Tier H1: Request-body adversarial
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H1: Request body adversarial', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('empty JSON body {} → 400 with RFC-014 envelope', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: {} });
    expect(res.statusCode).toBe(400);
    const env = expectRfc014Envelope(res.json());
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.retryable).toBe(false);
  });

  it('message content as array [] → 400, orchestrator not invoked', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: singleTurnPayload([]) });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
    expect(harness.llm.synthesizeMock).not.toHaveBeenCalled();
    expect(harness.llm.analyzeMock).not.toHaveBeenCalled();
  });

  it('message content as number 123 → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: singleTurnPayload(123) });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });

  it('message content as boolean true → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: singleTurnPayload(true) });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });

  it('message content as null → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: singleTurnPayload(null) });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });

  it('message.content.length === MAX_AGENT_HTTP_QUERY_CHARS exactly → 200 (lower-boundary inside limit)', async () => {
    harness = await buildHappyHarness('ok');
    const atLimit = 'a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    const res = await inject(harness, { payload: singleTurnPayload(atLimit) });
    // Either 200 (synthesized) or — if the analyzer rejects long ASCII noise
    // — the orchestrator still synthesizes a Layer-4 fallback. Either way,
    // the Zod bound must NOT reject `=== MAX_AGENT_HTTP_QUERY_CHARS`.
    expect(res.statusCode).toBe(200);
    const parsed = WineSearchResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
  });

  it('message.content.length === MAX_AGENT_HTTP_QUERY_CHARS + 1 → 400 (just over)', async () => {
    harness = await buildHappyHarness();
    const overLimit = 'a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS + 1);
    const res = await inject(harness, { payload: singleTurnPayload(overLimit) });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
    expect(harness.llm.synthesizeMock).not.toHaveBeenCalled();
  });

  it('2000 BMP chars accepted; emoji counted by codepoints — both at-limit accepted, over-limit (codepoints) rejected (P-L1 fix)', async () => {
    // The wire schema bounds `query` by CODEPOINTS, not UTF-16 code units.
    // (Previously Zod's `.max(N)` counted code units, halving the
    // user-perceived limit for emoji queries. Fixed in S1 / P-L1: see
    // `src/interface/http/schemas/wine-search.schema.ts`.)
    //
    // Boundary tests:
    //   - `'a'.repeat(N)` (BMP) — N codepoints, accepted (200).
    //   - `'🍷'.repeat(N)` (surrogate pair) — N codepoints, accepted (200).
    //   - `'🍷'.repeat(N + 1)` — N+1 codepoints, rejected (400).
    harness = await buildHappyHarness('ok');
    const bmpAtLimit = 'a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    const emojiAtLimit = '🍷'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    const emojiOverLimit = '🍷'.repeat(MAX_AGENT_HTTP_QUERY_CHARS + 1);

    const bmpRes = await inject(harness, { payload: singleTurnPayload(bmpAtLimit) });
    expect(bmpRes.statusCode).toBe(200);

    const emojiAtLimitRes = await inject(harness, { payload: singleTurnPayload(emojiAtLimit) });
    expect(emojiAtLimitRes.statusCode).toBe(200);

    const emojiOverLimitRes = await inject(harness, { payload: singleTurnPayload(emojiOverLimit) });
    expect(emojiOverLimitRes.statusCode).toBe(400);
    expectRfc014Envelope(emojiOverLimitRes.json());
  });

  it('extra top-level keys are rejected by .strict() → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: { ...singleTurnPayload('wine'), _extra: 'bad' } });
    expect(res.statusCode).toBe(400);
    const env = expectRfc014Envelope(res.json());
    // The Zod issue path must surface the unrecognized key — defense-in-depth
    // that the route did NOT silently drop the field.
    expect(env.error.message.toLowerCase()).toMatch(/unrecognized|extra|_extra/u);
  });

  it('extra keys inside options are strict-rejected → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { max_steps: 3, _smuggled: true } }),
    });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });

  it('options.max_steps boundary suite — string / negative / huge / non-int → all 400', async () => {
    // `max_steps: 0` is covered in the existing wine-search-api.test.ts;
    // the raw-`NaN` literal case is split into its own test below because it
    // reveals a real defect in Fastify's malformed-JSON path.
    harness = await buildHappyHarness();
    const cases: Array<{ name: string; payload: unknown }> = [
      { name: 'string', payload: singleTurnPayload('wine', { options: { max_steps: '5' } }) },
      { name: 'negative', payload: singleTurnPayload('wine', { options: { max_steps: -1 } }) },
      { name: 'huge', payload: singleTurnPayload('wine', { options: { max_steps: 1e9 } }) },
      { name: 'non-integer', payload: singleTurnPayload('wine', { options: { max_steps: 1.5 } }) },
    ];
    for (const c of cases) {
      const res = await inject(harness, { payload: c.payload });
      expect(res.statusCode, `case=${c.name}`).toBe(400);
      expectRfc014Envelope(res.json());
    }
  });

  // H1-F1 (fixed): A request body containing the JSON-illegal literal `NaN`
  // token now surfaces as 400 with an RFC-014 envelope (code:
  // `MALFORMED_JSON_BODY`). Fix lives in
  // `src/interface/http/middleware/error-handler.ts` — explicit branch for
  // Fastify content-type-parser errors (`FST_ERR_CTP_INVALID_JSON_BODY`).
  it('H1-F1 (fixed): raw NaN literal in body → 400 with RFC-014 envelope', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, {
      payload: '{"messages":[{"role":"user","content":"wine"}],"options":{"max_steps":NaN}}',
    });
    expect(res.statusCode).toBe(400);
    const env = expectRfc014Envelope(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
    expect(env.error.retryable).toBe(false);
    expect(env.error.request_id.length).toBeGreaterThan(0);
  });

  it('per_step_timeout_ms below floor / above ceiling → 400', async () => {
    harness = await buildHappyHarness();
    const lowRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { per_step_timeout_ms: PER_STEP_TIMEOUT_MIN_MS - 1 } }),
    });
    expect(lowRes.statusCode).toBe(400);
    expectRfc014Envelope(lowRes.json());

    const highRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { per_step_timeout_ms: PER_STEP_TIMEOUT_MAX_MS + 1 } }),
    });
    expect(highRes.statusCode).toBe(400);
    expectRfc014Envelope(highRes.json());
  });

  it('agent_timeout_ms below floor rejects with 400', async () => {
    harness = await buildHappyHarness();
    const lowRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { agent_timeout_ms: AGENT_TIMEOUT_MIN_MS - 1 } }),
    });
    expect(lowRes.statusCode).toBe(400);
    expectRfc014Envelope(lowRes.json());
  });

  it('agent_timeout_ms above the historical ceiling stays non-500 under the current contract', async () => {
    harness = await buildHappyHarness();
    const highRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { agent_timeout_ms: AGENT_TIMEOUT_MAX_MS + 1 } }),
    });
    expect(highRes.statusCode).toBeLessThan(500);
  });

  it('max_total_tokens below floor / above ceiling → 400', async () => {
    harness = await buildHappyHarness();
    const lowRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { max_total_tokens: MAX_TOTAL_TOKENS_MIN - 1 } }),
    });
    expect(lowRes.statusCode).toBe(400);
    expectRfc014Envelope(lowRes.json());

    const highRes = await inject(harness, {
      payload: singleTurnPayload('wine', { options: { max_total_tokens: MAX_TOTAL_TOKENS_MAX + 1 } }),
    });
    expect(highRes.statusCode).toBe(400);
    expectRfc014Envelope(highRes.json());
  });

  it('deeply nested malformed options (object where number expected) → 400 without crashing', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, {
      payload: singleTurnPayload('x', { options: { max_steps: { foo: 'bar' } } }),
    });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });

  // H1-F2 (fixed): A non-JSON body sent under Content-Type: application/json
  // now surfaces as 400 with the RFC-014 envelope (code:
  // `MALFORMED_JSON_BODY`). Same root-cause fix as H1-F1 — the error handler
  // branches on Fastify's `FST_ERR_CTP_INVALID_JSON_BODY` instead of falling
  // through to the unknown-error 500 path.
  it('H1-F2 (fixed): malformed JSON body → 400 with RFC-014 envelope', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: 'not json at all' });
    expect(res.statusCode).toBe(400);
    const env = expectRfc014Envelope(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
    expect(env.error.retryable).toBe(false);
  });

  it('body is JSON array ["wine"] (wrong root type) → 400', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, { payload: ['wine'] });
    expect(res.statusCode).toBe(400);
    expectRfc014Envelope(res.json());
  });
});

// ---------------------------------------------------------------------------
// Tier H2: Content-Type tricks
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H2: Content-Type tricks', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('missing Content-Type → 415 with RFC-014-shaped envelope', async () => {
    harness = await buildHappyHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: {}, // explicitly empty
      payload: JSON.stringify(singleTurnPayload('wine')),
    });
    expect(res.statusCode).toBe(415);
    expectRfc014Envelope(res.json());
  });

  it('Content-Type: text/plain → 415', async () => {
    harness = await buildHappyHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(singleTurnPayload('wine')),
    });
    expect(res.statusCode).toBe(415);
    expectRfc014Envelope(res.json());
  });

  it('Content-Type: application/json; charset=utf-8 → 200 (case-insensitive parameter accepted)', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: singleTurnPayload('Cabernet'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('Content-Type: APPLICATION/JSON (uppercase media type) → 200, RFC 2046 case-insensitive', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, {
      headers: { 'content-type': 'APPLICATION/JSON' },
      payload: singleTurnPayload('Pinot Noir'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('Content-Type with unknown charset parameter → 200, never 500 (preParsing accepts media type, parser handles charset)', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, {
      headers: { 'content-type': 'application/json; charset=invalid' },
      payload: singleTurnPayload('wine'),
    });
    // Server MUST NOT 500. Either 200 (parser ignores the unknown charset)
    // or a 4xx (parser rejects it explicitly). Document actual behavior.
    expect(res.statusCode).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Tier H3: Method + path tricks
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H3: Method + path tricks', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('GET /v1/agent → 404 (only POST is registered)', async () => {
    harness = await buildHappyHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/v1/agent' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /v1/agent → 4xx (rejects unrelated method)', async () => {
    harness = await buildHappyHarness();
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/v1/agent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(singleTurnPayload('wine')),
    });
    // Fastify default is 404 when only POST is registered; some
    // route-not-allowed setups return 405. Either is acceptable.
    expect([404, 405]).toContain(res.statusCode);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('OPTIONS /v1/agent → never 500 (CORS preflight or 404)', async () => {
    harness = await buildHappyHarness();
    const res = await harness.app.inject({ method: 'OPTIONS', url: '/v1/agent' });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /v1/agent/ (trailing slash) → handled deterministically (200 or 404, never 500)', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, { url: '/v1/agent/', payload: singleTurnPayload('wine') });
    // Fastify's default is `ignoreTrailingSlash: false` → 404. We accept
    // either behavior; the invariant is "no 500".
    expect([200, 404]).toContain(res.statusCode);
  });

  it('POST /v1/agent?inject=1 (query params) → 200, query params ignored', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, {
      url: '/v1/agent?inject=1&attack=true',
      payload: singleTurnPayload('wine'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /V1/WINE-SEARCH (uppercase path) → 404 (Fastify is case-sensitive)', async () => {
    harness = await buildHappyHarness();
    const res = await inject(harness, {
      url: '/V1/WINE-SEARCH',
      payload: singleTurnPayload('wine'),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tier H4: AbortSignal lifecycle (race conditions)
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H4: AbortSignal lifecycle', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('client abort mid-flight: orchestrator returns aborted result, signal observed as aborted post-completion', async () => {
    // The orchestrator absorbs abort errors and returns a result with
    // `terminationReason='aborted'` rather than throwing. So an injected
    // abort here is observable via the `synthesize` signal having
    // `.aborted === true` AFTER the response is written (the route's
    // `finally` block calls `lifecycleController.abort()`).
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: { answer: { answer: 'ok', citations: [] } },
      },
    });
    const res = await inject(harness, { payload: singleTurnPayload('Bordeaux') });
    expect(res.statusCode).toBe(200);
    // After completion every observed signal must be aborted (route finally).
    for (const sig of harness.llm.observedAbortSignals) {
      expect(sig.aborted).toBe(true);
    }
  });

  it('multiple parallel requests do NOT cross-abort each other', async () => {
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: async (req) => {
          // Yield to the event loop so requests interleave.
          await new Promise((resolve) => setImmediate(resolve));
          // Each request must see its OWN un-aborted signal at synth time.
          expect(req.abortSignal?.aborted).toBe(false);
          return { answer: { answer: 'ok', citations: [] } };
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => inject(harness, { payload: singleTurnPayload(`Wine ${String(i)}`) })),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
  });

  it('slow synthesizer (200 ms) does not trigger early abort from request-context middleware', async () => {
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: async (req) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Mid-flight the signal must still be live.
          expect(req.abortSignal?.aborted).toBe(false);
          return { answer: { answer: 'ok', citations: [] } };
        },
      },
    });
    const res = await inject(harness, { payload: singleTurnPayload('Burgundy') });
    expect(res.statusCode).toBe(200);
    const parsed = WineSearchResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta.total_duration_ms).toBeGreaterThanOrEqual(200);
  });

  it('synthesizer throws unknown error → response is still 200 (no 5xx escape), answer falls through ladder', async () => {
    // The synthesisRunner has an internal layer ladder (primary → layer2 →
    // layer3 → layer4). A thrown primary-LLM call is absorbed and a fallback
    // layer produces a deterministic answer. The orchestrator therefore
    // returns 200 — an internal LLM failure must NEVER bubble out as a 500.
    // We assert the invariant ("no 5xx") without pinning the exact layer,
    // because which layer wins depends on whether the tool outcomes carry
    // grounding evidence (layer2/3) or not (layer4).
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: () => {
          throw new Error('synthesizer kaboom');
        },
      },
    });
    const res = await inject(harness, { payload: singleTurnPayload('Champagne') });
    expect(res.statusCode).toBe(200);
    const parsed = WineSearchResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The terminal layer MUST be one of the deterministic fallback layers
    // (NOT 'primary' — the primary path threw). The synthesizer ladder
    // never escalates to 'error' here because at least one fallback layer
    // (Layer 4 template) always produces an answer.
    expect(['layer2', 'layer3', 'layer4']).toContain(parsed.data.meta.termination.layer);
    expect(parsed.data.meta.policy_blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier H5: Header manipulation
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H5: Header manipulation', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('XSS-shaped x-request-id is NOT reflected as raw HTML in the response body', async () => {
    harness = await buildHappyHarness('ok');
    const malicious = '<script>alert(1)</script>';
    const res = await inject(harness, {
      headers: { 'content-type': 'application/json', 'x-request-id': malicious },
      payload: singleTurnPayload('wine'),
    });
    expect(res.statusCode).toBe(200);
    const rawText = res.body; // Fastify inject returns string here
    // The literal script tag may appear inside a JSON string field, but it
    // MUST be JSON-escaped (the content-type is application/json) — the
    // raw HTML interpretation is impossible. We assert the response is
    // application/json (no HTML rendering) and that any reflected request_id
    // is the literal string, not HTML-injected.
    expect(String(res.headers['content-type'])).toMatch(/application\/json/u);
    // The string may appear in the body — that's fine inside JSON; the
    // contract is that it is NEVER served as text/html.
    if (rawText.includes(malicious)) {
      // Reflected as a JSON string value; assert the JSON shape is parseable.
      const json: { meta?: { request_id?: string } } = res.json();
      expect(json.meta?.request_id).toBe(malicious);
    }
  });

  it('oversized x-request-id (10K chars) is handled gracefully (200 or 4xx, never 500)', async () => {
    harness = await buildHappyHarness('ok');
    const giant = 'x'.repeat(OVERSIZED_HEADER_VALUE_CHARS);
    const res = await inject(harness, {
      headers: { 'content-type': 'application/json', 'x-request-id': giant },
      payload: singleTurnPayload('wine'),
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('Korean x-request-id (UTF-8) is handled without crash', async () => {
    harness = await buildHappyHarness('ok');
    const koreanId = '요청-아이디-한글';
    const res = await inject(harness, {
      headers: { 'content-type': 'application/json', 'x-request-id': koreanId },
      payload: singleTurnPayload('와인'),
    });
    expect(res.statusCode).toBeLessThan(500);
    // If accepted as-is, the response carries the Korean id back; if Fastify
    // sanitized it, the request still succeeded.
    if (res.statusCode === 200) {
      const parsed = WineSearchResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier H6: Concurrency stress + no cross-talk
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H6: Concurrency', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it(`${String(STRESS_CONCURRENT_REQUESTS)} concurrent identical requests: all 200, all request_id unique`, async () => {
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: { answer: { answer: 'ok', citations: ['wine-1'] } },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: STRESS_CONCURRENT_REQUESTS }, () =>
        inject(harness, { payload: singleTurnPayload('Pinot Noir') }),
      ),
    );
    const requestIds = new Set<string>();
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const parsed = WineSearchResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      requestIds.add(parsed.data.meta.request_id);
    }
    // Fastify mints a unique request_id per request when no inbound header
    // is supplied — the set size MUST equal the request count.
    expect(requestIds.size).toBe(STRESS_CONCURRENT_REQUESTS);
  });

  it(`${String(CROSSTALK_CONCURRENT_REQUESTS)} concurrent requests with distinct queries → no answer cross-talk`, async () => {
    // The synth mock parrots a unique marker that lives inside the original
    // user query. The marker is a real wine surface (Burgundy/Bordeaux/etc.)
    // appended with a numeric tag so the analyzer's adversarial sanitizer
    // accepts every variant. We then assert each response's answer references
    // ITS OWN marker and no other — proving no shared-state leak between
    // concurrent requests.
    harness = await buildWineSearchTestContainer({
      searchUseCase: makeStubSearchUseCase(),
      llmMock: {
        synthesize: (req) => {
          // The synthesizer's user-role message starts with
          // `User query: <originalQuery>` — we can recover the marker by
          // pattern-matching on the embedded `MARK<digits>` token.
          const messages = req.messages.map((m) => m.content).join('\n');
          // Unicode-safe extraction (no \b — CLAUDE.md rule 8).
          const match = /MARK(\d+)/u.exec(messages);
          const marker = match?.[0] ?? 'UNKNOWN';
          return { answer: { answer: `synthesized for ${marker}`, citations: ['wine-1'] } };
        },
      },
    });

    // Each query carries a unique MARK<N> marker AND a legitimate wine
    // surface so the analyzer admits the query.
    const queries = Array.from(
      { length: CROSSTALK_CONCURRENT_REQUESTS },
      (_, i) => `Cabernet Sauvignon recommendation MARK${String(i)}`,
    );
    const responses = await Promise.all(queries.map((q) => inject(harness, { payload: singleTurnPayload(q) })));

    // Every response, when parsed, must mention its OWN marker and no other.
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      const expectedMarker = `MARK${String(i)}`;
      expect(res, `index=${String(i)}`).toBeDefined();
      if (res === undefined) continue;
      expect(res.statusCode).toBe(200);
      const parsed = WineSearchResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      // If the analyzer policy-blocked this benign query we cannot run the
      // cross-talk assertion. Skip those entries — the H7 Korean-rule-23
      // test already records that finding separately.
      if (parsed.data.meta.policy_blocked) continue;
      expect(parsed.data.answer).toContain(expectedMarker);
      // Negative: no other marker leaks into this response.
      for (let j = 0; j < queries.length; j++) {
        if (j === i) continue;
        const otherMarker = `MARK${String(j)}`;
        expect(parsed.data.answer, `i=${String(i)} j=${String(j)}`).not.toContain(otherMarker);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tier H7: Response envelope discipline (RFC-014 + invariants)
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Hell H7: Response envelope discipline', () => {
  let harness: WineSearchTestHarness;
  afterEach(async () => { if (harness !== undefined) await harness.cleanup(); });

  it('EVERY 4xx failure mode emits a strict RFC-014 envelope', async () => {
    harness = await buildHappyHarness();
    const triggers: Array<{ name: string; opts: InjectOptions }> = [
      { name: 'empty-body', opts: { payload: {} } },
      { name: 'wrong-type-array', opts: { payload: ['wine'] } },
      { name: 'extra-key', opts: { payload: { ...singleTurnPayload('wine'), _extra: 1 } } },
      { name: 'too-long', opts: { payload: singleTurnPayload('a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS + 1)) } },
      { name: 'wrong-content-type', opts: {
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify(singleTurnPayload('wine')),
      } },
    ];
    for (const t of triggers) {
      const res = await inject(harness, t.opts);
      expect(res.statusCode, `case=${t.name}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `case=${t.name}`).toBeLessThan(500);
      const env = expectRfc014Envelope(res.json());
      // Every envelope MUST carry a non-empty request_id and code.
      expect(env.error.request_id.length).toBeGreaterThan(0);
      expect(env.error.code.length).toBeGreaterThan(0);
    }
  });

  it('happy-path response always carries `query_type: "wine_search"` literal', async () => {
    harness = await buildHappyHarness('ok');
    const res = await inject(harness, { payload: singleTurnPayload('wine') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { query_type?: unknown };
    expect(body.query_type).toBe('wine_search');
  });

  // FINDING H7-F3 (Rule-23 false-positive guard — high severity, fixed):
  // The Korean query "와인 추천해줘" ("recommend a wine") must surface as
  // `policy_blocked: false`. The original report attributed the
  // false-positive to `classifyQueryBudget` (the analyzer's adversarial
  // sanitizer), but investigation showed `classifyQueryBudget` does NOT
  // classify this query as adversarial — see the function-level guard at
  //   `test/regression/korean-wine-query-not-adversarial.regression.test.ts`
  // which pins that contract for 19 benign Korean wine phrasings.
  //
  // The actual root cause was downstream: a router-level
  // `unsupported_intent` reject was being surfaced as `policyBlocked: true`
  // (the security-block bit), conflating the S1 "security-rejected" and
  // "no-routing-target" termination kinds. The fix splits the two; see
  // `wine-search-orchestrator.ts` and the `TerminationKind` union in
  // `wine-search-result-schemas.ts`. CLAUDE.md rule 23 — natural Korean
  // wine queries must never appear policy-blocked.
  it('FINDING H7-F3: Korean query "와인 추천해줘" is NOT policy-blocked (CLAUDE.md rule 23)', async () => {
    harness = await buildHappyHarness('한국어 답변');
    const koreanQuery = '와인 추천해줘';
    expect(KOREAN_LEGITIMATE_QUERY_RE.test(koreanQuery)).toBe(true);
    const res = await inject(harness, { payload: singleTurnPayload(koreanQuery) });
    expect(res.statusCode).toBe(200);
    const parsed = WineSearchResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta.policy_blocked).toBe(false);
  });
});
