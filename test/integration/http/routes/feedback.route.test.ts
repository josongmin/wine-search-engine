import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerFeedbackRoute } from '../../../../src/interface/http/routes/feedback.route.js';
import type { FeedbackRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { FeedbackStore } from '../../../../src/domain/learning/port/feedback-store.port.js';
import type { FeedbackSignal } from '../../../../src/domain/learning/model/feedback-signal.js';
import { resolveIncomingRequestId } from '../../../../src/interface/http/request-id.js';
import { ErrorResponseSchema } from '../../../../src/interface/http/schemas/search-response.schema.js';
import {
  MAX_ERROR_ENVELOPE_MESSAGE_CHARS,
  MAX_FEEDBACK_ENTITY_REF_CHARS,
} from '../../../../src/interface/http/constants.js';

// ---------------------------------------------------------------------------
// Korean fixture construction: build NFC/NFD test inputs from code points so
// the tests never depend on the source file's own encoding form. Editors and
// review tooling sometimes silently re-normalize Korean literals on save,
// which would invalidate hand-typed NFC/NFD comparisons.
// ---------------------------------------------------------------------------
// 샤 (sya) — single precomposed Hangul syllable.
// We compute it from Choseong + Jungseong jamo so the test is reproducible.
const HANGUL_S_CHOSEONG = 'ᄉ';
const HANGUL_YA_JUNGSEONG = 'ᅣ';
const SHA_NFD = HANGUL_S_CHOSEONG + HANGUL_YA_JUNGSEONG; // 2 code units
const SHA_NFC = SHA_NFD.normalize('NFC'); // 1 code unit (precomposed 샤)

// Header-safe request id (matches REQUEST_ID_SAFE_PATTERN in
// src/domain/shared/utils/request-id.ts). Used to assert that the route
// threads an inbound X-Request-Id through to the FeedbackStore call and
// the response envelope on the error paths.
const SAFE_INBOUND_REQUEST_ID = 'feedback-route-test-req-001';

function makeFeedbackStore(
  saveImpl: (signal: FeedbackSignal) => Promise<void> = async () => undefined,
): FeedbackStore {
  return {
    saveFeedback: vi.fn(saveImpl),
    getFeedback: vi.fn(),
    getAggregatedStats: vi.fn(),
    pruneExpiredFeedback: vi.fn(),
  } as unknown as FeedbackStore;
}

function makeDeps(
  overrides?: Partial<FeedbackRouteDeps>,
): FeedbackRouteDeps {
  const baseStore = makeFeedbackStore();
  return {
    feedbackStore: overrides?.feedbackStore === undefined ? baseStore : overrides.feedbackStore,
    feedbackIngestEnabled: overrides?.feedbackIngestEnabled ?? true,
  };
}

async function post(
  app: FastifyInstance,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/feedback',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

function validBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    query: 'Opus One 2018',
    entity_id: 'wine-opus-one-2018',
    signal_type: 'click',
    session_id: 'session-test-001',
    ...overrides,
  };
}

describe('POST /v1/feedback', () => {
  let app: FastifyInstance;
  let deps: FeedbackRouteDeps;

  beforeEach(async () => {
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps();
    registerFeedbackRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Happy-path: positive + negative signals
  // -------------------------------------------------------------------------
  it('accepts a "click" positive signal with 201 + accepted=true and persists via FeedbackStore', async () => {
    // Smoke test for the primary positive feedback path. Asserts (1) the
    // contract status (201 Created, not 200 — feedback ingest is a write),
    // (2) the response envelope shape, and (3) that the route actually
    // called the port (no silent drop).
    const response = await post(app, validBody());

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.accepted).toBe(true);
    expect(typeof body.signal_id).toBe('string');
    expect(body.signal_id.length).toBeGreaterThan(0);

    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    expect(saveFn).toHaveBeenCalledTimes(1);
    const signal = saveFn.mock.calls[0]?.[0] as FeedbackSignal;
    expect(signal).toMatchObject({
      type: 'click',
      query: 'Opus One 2018',
      entityId: 'wine-opus-one-2018',
      isPositive: true,
      sessionId: 'session-test-001',
    });
  });

  it('accepts a "purchase" positive signal with 201 + isPositive=true', async () => {
    // Purchases are the strongest positive signal in the learning loop.
    // Verify the signal_type → FeedbackType mapping doesn't accidentally
    // flip the polarity (a real bug class — mapSignal lives in the route).
    const response = await post(app, validBody({ signal_type: 'purchase' }));

    expect(response.statusCode).toBe(201);
    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    const signal = saveFn.mock.calls[0]?.[0] as FeedbackSignal;
    expect(signal.type).toBe('purchase');
    expect(signal.isPositive).toBe(true);
  });

  it('accepts a "dismiss" negative signal with 201 + isPositive=false (mapped to explicit_feedback)', async () => {
    // The single negative path in the current schema. The route's mapSignal
    // converts HTTP 'dismiss' → domain 'explicit_feedback' with isPositive=false.
    // Mis-mapping here corrupts the entire learning signal.
    const response = await post(app, validBody({ signal_type: 'dismiss' }));

    expect(response.statusCode).toBe(201);
    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    const signal = saveFn.mock.calls[0]?.[0] as FeedbackSignal;
    expect(signal.type).toBe('explicit_feedback');
    expect(signal.isPositive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Validation: RFC-014 error envelope branches
  // -------------------------------------------------------------------------
  it('rejects a missing required field (entity_id) with 400 + VALIDATION_ERROR envelope', async () => {
    const body = validBody();
    delete body['entity_id'];

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(ErrorResponseSchema.safeParse(json).success).toBe(true);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.request_id).toEqual(expect.any(String));
    expect(json.error.request_id.length).toBeGreaterThan(0);

    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('rejects a missing required field (session_id) with 400 + VALIDATION_ERROR envelope', async () => {
    // Adjacent missing-field coverage. session_id is required for session-
    // level aggregation in the learning loop; a missing session_id MUST be a
    // hard reject (not silently substituted) to avoid bucketing distinct
    // browsers into one synthetic session.
    const body = validBody();
    delete body['session_id'];

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid signal_type value with 400 + VALIDATION_ERROR envelope', async () => {
    // The signal_type enum is locked to click/purchase/dismiss. An unknown
    // value MUST 400 — accepting it silently would short-circuit mapSignal's
    // fallback into 'explicit_feedback', corrupting the learning loop.
    const response = await post(app, validBody({ signal_type: 'unknown-signal' }));

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(ErrorResponseSchema.safeParse(json).success).toBe(true);
    expect(json.error.code).toBe('VALIDATION_ERROR');

    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('rejects an empty entity_id with 400 + VALIDATION_ERROR envelope', async () => {
    // Adjacent empty-input check. Schema uses min(1); an empty string MUST
    // 400 rather than persisting a row with a blank entity reference.
    const response = await post(app, validBody({ entity_id: '' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty query with 400 + VALIDATION_ERROR envelope', async () => {
    const response = await post(app, validBody({ query: '' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an oversized query (> MAX_ERROR_ENVELOPE_MESSAGE_CHARS) with 400 + VALIDATION_ERROR envelope', async () => {
    // Schema-bound boundary test (CLAUDE.md test-discipline rule 6): a value
    // just outside MAX_ERROR_ENVELOPE_MESSAGE_CHARS MUST 400. The bound is the
    // same shared constant the schema uses, so this also guards against a
    // silent constant drift breaking the contract.
    const oversized = 'a'.repeat(MAX_ERROR_ENVELOPE_MESSAGE_CHARS + 1);

    const response = await post(app, validBody({ query: oversized }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an oversized entity_id (> MAX_FEEDBACK_ENTITY_REF_CHARS) with 400 + VALIDATION_ERROR envelope', async () => {
    // Mirror boundary test for the entity_id length bound. Without this the
    // PG `entity_id` column could be silently truncated by a downstream
    // adapter — better to reject at the HTTP boundary.
    const oversized = 'a'.repeat(MAX_FEEDBACK_ENTITY_REF_CHARS + 1);

    const response = await post(app, validBody({ entity_id: oversized }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown extra body field with 400 (schema is .strict())', async () => {
    // The feedback request schema is .strict() (CLAUDE.md test-discipline
    // rule 10), so unknown keys MUST fail validation. This locks the schema
    // shape so callers cannot silently emit fields that the route would
    // otherwise ignore (e.g. "isPositive: false" — a client trying to flip
    // the polarity of a click).
    const response = await post(app, validBody({ isPositive: false }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  // -------------------------------------------------------------------------
  // Korean unicode handling — first-class citizens in this engine
  // -------------------------------------------------------------------------
  it('accepts a Korean query and forwards it verbatim (NFC preserved)', async () => {
    // Korean queries are first-class. The route must not lossy-encode,
    // strip, or normalize them on the way to the feedback store — that
    // is the canonical-alias layer's job downstream.
    const koreanQuery = `${SHA_NFC} 2016 와인 추천`;

    const response = await post(app, validBody({ query: koreanQuery }));

    expect(response.statusCode).toBe(201);
    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    const signal = saveFn.mock.calls[0]?.[0] as FeedbackSignal;
    expect(signal.query).toBe(koreanQuery);
  });

  it('preserves Korean NFC and NFD forms verbatim at the route boundary', async () => {
    // The route MUST NOT silently auto-normalize Unicode forms. The
    // canonical-alias resolver downstream owns NFC normalization; if the
    // route pre-normalizes, downstream telemetry that correlates incoming
    // raw bytes to outbound canonical IDs loses fidelity.
    expect(SHA_NFC.length).toBe(1);
    expect(SHA_NFD.length).toBe(2);
    expect(SHA_NFC).not.toBe(SHA_NFD);
    expect(SHA_NFD.normalize('NFC')).toBe(SHA_NFC);

    await post(app, validBody({ query: SHA_NFC }));
    await post(app, validBody({ query: SHA_NFD }));

    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    const calls = saveFn.mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0]?.[0] as FeedbackSignal).query).toBe(SHA_NFC);
    expect((calls[1]?.[0] as FeedbackSignal).query).toBe(SHA_NFD);
    expect((calls[1]?.[0] as FeedbackSignal).query.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Request-Id propagation (RFC-014)
  // -------------------------------------------------------------------------
  it('threads inbound X-Request-Id into the VALIDATION_ERROR envelope', async () => {
    // On a 400 the error envelope must carry the inbound request_id verbatim
    // so the caller can correlate retries against their tracing pipeline.
    const body = validBody();
    delete body['entity_id'];

    const response = await post(app, body, { 'x-request-id': SAFE_INBOUND_REQUEST_ID });

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.request_id).toBe(SAFE_INBOUND_REQUEST_ID);
  });

  // -------------------------------------------------------------------------
  // Idempotency-Key header (UUID-shaped) → reused as signal_id
  // -------------------------------------------------------------------------
  it('honors a UUID-shaped Idempotency-Key header as the signal_id', async () => {
    // The route extracts a UUID-shaped Idempotency-Key for retry-safety.
    // Validate that (1) a well-formed UUID is honored verbatim and (2) the
    // response signal_id mirrors the persisted signal so callers can detect
    // dedupe on retries.
    const idempotencyKey = '00000000-0000-4000-8000-000000000abc';

    const response = await post(app, validBody(), { 'idempotency-key': idempotencyKey });

    expect(response.statusCode).toBe(201);
    expect(response.json().signal_id).toBe(idempotencyKey);

    const saveFn = deps.feedbackStore?.saveFeedback as ReturnType<typeof vi.fn>;
    expect((saveFn.mock.calls[0]?.[0] as FeedbackSignal).signalId).toBe(idempotencyKey);
  });

  it('ignores a non-UUID Idempotency-Key and falls back to a server-generated id', async () => {
    // Header-injection / log-poisoning defense: a non-UUID Idempotency-Key
    // MUST be silently dropped, not propagated to the DB row. The route
    // falls back to a UUID generated via crypto.randomUUID(), so we cannot
    // assert the exact value, only that it differs from the bad header and
    // that the save still succeeded.
    const badKey = "'; DROP TABLE feedback; --";

    const response = await post(app, validBody(), { 'idempotency-key': badKey });

    expect(response.statusCode).toBe(201);
    const signalId = response.json().signal_id as string;
    expect(signalId).not.toBe(badKey);
    expect(signalId.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Kill-switch / unavailable port
  // -------------------------------------------------------------------------
  it('returns 503 FEEDBACK_UNAVAILABLE when feedbackIngestEnabled=false', async () => {
    // Kill-switch path. When learning is disabled the route MUST surface
    // a 503 with a retryable RFC-014 envelope instead of pretending to
    // accept the write — silent drops corrupt downstream learning offline.
    await app.close();
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps({ feedbackIngestEnabled: false });
    registerFeedbackRoute(app, deps);
    await app.ready();

    const response = await post(app, validBody());

    expect(response.statusCode).toBe(503);
    const json = response.json();
    expect(ErrorResponseSchema.safeParse(json).success).toBe(true);
    expect(json.error.code).toBe('FEEDBACK_UNAVAILABLE');
    expect(json.error.retryable).toBe(true);
  });

  it('returns 503 FEEDBACK_UNAVAILABLE when feedbackStore is null (PG not configured)', async () => {
    // Companion path to the kill-switch. A null FeedbackStore means PG
    // is unreachable; the route MUST still degrade with a contract-shaped
    // 503 (not throw) so callers see a stable envelope.
    await app.close();
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    deps = makeDeps({ feedbackStore: null });
    registerFeedbackRoute(app, deps);
    await app.ready();

    const response = await post(app, validBody());

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('FEEDBACK_UNAVAILABLE');
  });

  // -------------------------------------------------------------------------
  // Unexpected ingestion failure → flows through error handler (no fabricated 200)
  // -------------------------------------------------------------------------
  it('propagates an unexpected ingestion error to the RFC-014 500 envelope (no fabricated 201)', async () => {
    // CLAUDE.md schema-quality-bar: catch blocks MUST NOT fabricate a
    // success-shaped response from unknown errors. A throw in saveFeedback
    // MUST surface as a 500 RFC-014 envelope — the route handler does NOT
    // wrap the call in a try/catch by design (verified by reading the route).
    await app.close();
    app = Fastify({ genReqId: (req) => resolveIncomingRequestId(req.headers) });
    registerRequestContext(app);
    app.setErrorHandler(errorHandler);
    const failingStore = makeFeedbackStore(async () => {
      throw new Error('pg connection refused');
    });
    deps = makeDeps({ feedbackStore: failingStore });
    registerFeedbackRoute(app, deps);
    // Silence the expected error log so the test output stays clean. Use a
    // narrow stub — we just need the test to not bury the assertion under
    // a noisy stack trace.
    app.log.error = vi.fn();
    await app.ready();

    const response = await post(app, validBody());

    expect(response.statusCode).toBe(500);
    const json = response.json();
    expect(ErrorResponseSchema.safeParse(json).success).toBe(true);
    expect(typeof json.error.code).toBe('string');
    expect(json.error.code.length).toBeGreaterThan(0);
    // The 500 envelope MUST NOT echo "accepted: true" — that would be a
    // fabricated success-shaped response (banned by CLAUDE.md).
    expect(json).not.toHaveProperty('accepted');
    expect(json).not.toHaveProperty('signal_id');
  });

  // -------------------------------------------------------------------------
  // Bot-like rapid-fire / 429 detection — currently NOT implemented at the
  // route level (the contract declares the 429 response schema but no
  // rate-limiter is wired here; rate limiting is a Fastify-plugin concern
  // applied at the server composition root). Document the gap rather than
  // forcing a fake assertion that would mask the missing feature.
  // -------------------------------------------------------------------------
  it.todo(
    'rejects bot-like rapid-fire requests from the same IP with 429 (route-level rate-limit not yet wired)',
  );
});
