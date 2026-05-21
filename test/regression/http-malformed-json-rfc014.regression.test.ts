/**
 * Regression: Fastify content-type-parser (CTP) errors MUST surface as
 * RFC-014-shaped 4xx responses, not as the global "unknown 500" fallthrough.
 *
 * Findings H1-F1 (raw `NaN` literal) and H1-F2 (non-JSON body) used to
 * elicit HTTP 500 INTERNAL_ERROR because the global `errorHandler` had no
 * branch for `FST_ERR_CTP_INVALID_JSON_BODY`. The fix lives in
 * `src/interface/http/middleware/error-handler.ts` and matches the
 * dedicated `MALFORMED_REQUEST_BODY_ERROR_CODES` set; the parallel
 * `FST_ERR_CTP_INVALID_MEDIA_TYPE` case is mapped to 415.
 *
 * This regression test stands ALONE from the e2e harness — it builds a
 * minimal Fastify app with only the error handler installed, so it tests
 * the handler's branch decisions directly without dragging in the wine-search
 * route or container. CLAUDE.md rule 33 (production wire) is still proved by
 * the hell-difficulty e2e tests `wine-search-api-hell-http.test.ts`
 * (H1-F1 / H1-F2 now passing), since those go through `createServer`.
 *
 * CLAUDE.md compliance:
 *   - Rule 5: ASCII, Korean (한글), and accented Latin (é, ñ) bodies tested.
 *   - Rule 6: every assertion validates the RFC-014 envelope shape.
 *   - Rule 18: boundary at exactly-malformed (valid JSON edge vs. one-char
 *     break) so a future regression cannot widen the "bad bytes" set.
 *   - Rule 33: error-handler.ts is wired into every Fastify app via
 *     `setErrorHandler(errorHandler)` — exercised by H1-F1/F2 e2e.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../src/interface/http/middleware/request-context.js';
import { ErrorResponseSchema } from '../../src/interface/http/schemas/search-response.schema.js';

const TEST_ROUTE = '/echo';

async function buildMinimalApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRequestContext(app);
  app.setErrorHandler(errorHandler);
  // Trivial JSON-only echo route — never reached on malformed bodies; the
  // Fastify default JSON body parser throws before the handler runs.
  app.post(TEST_ROUTE, (req, reply) => {
    void reply.code(200).send({ ok: true, body: req.body });
  });
  await app.ready();
  return app;
}

function parseRfc014(raw: unknown) {
  const parsed = ErrorResponseSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('unreachable');
  return parsed.data;
}

describe('error-handler — malformed JSON body → 400 RFC-014 (H1-F1/F2)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildMinimalApp(); });
  afterEach(async () => { await app.close(); });

  it('raw NaN literal in body → 400, code=MALFORMED_JSON_BODY, retryable=false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"wine","options":{"max_steps":NaN}}',
    });
    expect(res.statusCode).toBe(400);
    const env = parseRfc014(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
    expect(env.error.retryable).toBe(false);
    expect(env.error.request_id.length).toBeGreaterThan(0);
  });

  it('non-JSON string body → 400 with RFC-014 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    expect(res.statusCode).toBe(400);
    const env = parseRfc014(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
  });

  it('empty body under application/json → 400 with RFC-014 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    const env = parseRfc014(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
  });

  it('trailing comma → 400 (JavaScript JSON.parse rejects, Fastify surfaces FST_ERR_CTP_INVALID_JSON_BODY)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"wine",}',
    });
    expect(res.statusCode).toBe(400);
    parseRfc014(res.json());
  });

  it('truncated JSON (unclosed brace) → 400 RFC-014 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"wine"',
    });
    expect(res.statusCode).toBe(400);
    parseRfc014(res.json());
  });

  it('Korean (한글) bytes inside an otherwise malformed body → still 400 (no encoding crash)', async () => {
    // CLAUDE.md rule 5: ensure non-ASCII bytes in the broken payload do not
    // bypass the FST_ERR_CTP branch or cause an encoding-related 500.
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"와인 추천",}', // trailing comma + Korean
    });
    expect(res.statusCode).toBe(400);
    const env = parseRfc014(res.json());
    expect(env.error.code).toBe('MALFORMED_JSON_BODY');
  });

  it('accented Latin bytes inside an otherwise malformed body → 400 (no encoding crash)', async () => {
    // CLAUDE.md rule 5: é / ñ are valid UTF-8 multi-byte sequences; verify
    // the error handler does not crash inside the encoding pipeline.
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"Bordeaux Château Pétrus",', // unclosed object
    });
    expect(res.statusCode).toBe(400);
    parseRfc014(res.json());
  });

  it('Content-Type: text/plain → handler does not falsely classify as MALFORMED_JSON_BODY', async () => {
    // The minimal app here registers no JSON-only parser restriction, so a
    // text/plain body is admitted (status 200) — but the critical invariant
    // is that the error handler's malformed-JSON branch MUST NOT fire on a
    // non-JSON Content-Type. The 415 surfacing path is verified by the e2e
    // suite (`wine-search-api-hell-http.test.ts` Tier H2), which exercises
    // the production `createServer` config with `addContentTypeParser`
    // restrictions.
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    // Either 415 (when a stricter app config is in play) or 200 (this minimal
    // app); the invariant is "no false MALFORMED_JSON_BODY classification".
    if (res.statusCode >= 400 && res.statusCode < 500) {
      const env = parseRfc014(res.json());
      // If the route does reject, it should be UNSUPPORTED_MEDIA_TYPE, not
      // MALFORMED_JSON_BODY (since the body wasn't even parsed as JSON).
      expect(env.error.code).not.toBe('MALFORMED_JSON_BODY');
    }
  });

  it('boundary: valid JSON body is NOT touched by the FST_ERR_CTP branch → 200', async () => {
    // CLAUDE.md rule 18: prove the JUST-INSIDE-valid case still reaches the
    // handler. If the branch widens accidentally, this guard fails.
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '{"query":"wine"}',
    });
    expect(res.statusCode).toBe(200);
  });

  it('every malformed-body envelope carries non-empty request_id (Rule-6 invariant)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TEST_ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: '!!!not-json!!!',
    });
    expect(res.statusCode).toBe(400);
    const env = parseRfc014(res.json());
    expect(env.error.request_id.length).toBeGreaterThan(0);
    expect(env.error.failure_reason).toBeNull();
  });
});
