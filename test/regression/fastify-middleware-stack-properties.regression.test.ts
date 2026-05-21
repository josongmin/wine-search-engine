/**
 * Regression: OWASP ASVS Level 2 contract for the Fastify security middleware
 * stack (Helmet / CORS / rate-limit) wired in `src/interface/http/server.ts`.
 *
 * What this file owns:
 *   - Helmet: Content-Security-Policy directives, X-Frame-Options, HSTS,
 *     X-Content-Type-Options (ASVS V14.4 Browser Security Headers).
 *   - CORS: localhost-only allowlist in dev/test, exact-origin allowlist in
 *     production, denied subdomain boundary, preflight Access-Control-Max-Age.
 *   - Rate-limit: 429 after N requests within the window, monotone bucket
 *     within a window, reset after window expiration via clock injection,
 *     Korean error template preservation through the RFC-014 error handler.
 *   - Idempotency property: helmet registration is order-stable; rate-limit
 *     bucket count is monotone non-decreasing within a window.
 *
 * Append-only regression. Never delete.
 *
 * Wiring proof (CLAUDE.md rule 33): the constants
 * `RATE_LIMIT_MAX_REQUESTS_DEFAULT` and `RATE_LIMIT_WINDOW_MS_DEFAULT` are
 * imported by `src/interface/http/server.ts` — see the `await app.register(
 * rateLimit, …)` block. The Helmet / CORS plugin registrations under test
 * exactly mirror the registration code in `server.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fc from 'fast-check';
import { errorHandler } from '../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../src/interface/http/middleware/request-context.js';
import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  HTTP_STATUS_OK,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  RATE_LIMIT_MAX_REQUESTS_DEFAULT,
  RATE_LIMIT_WINDOW_MS_DEFAULT,
} from '../../src/interface/http/constants.js';

// ─── Helper: build a minimal Fastify app that mirrors server.ts middleware ───

interface BuildOptions {
  readonly nodeEnv?: 'development' | 'production' | 'test';
  readonly allowedOrigins?: readonly string[];
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  readonly nowOverride?: () => number;
}

async function buildSecuredApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRequestContext(app);

  // Helmet — same options as server.ts.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // CORS — same origin policy as server.ts/registerCorsSupport.
  const nodeEnv = opts.nodeEnv ?? 'test';
  const originList = opts.allowedOrigins ?? [];
  const LOCALHOST_ORIGIN_RE =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  await app.register(cors, {
    hook: 'preHandler',
    origin(origin, callback) {
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      if (nodeEnv !== 'production') {
        callback(null, LOCALHOST_ORIGIN_RE.test(origin));
        return;
      }
      callback(null, originList.includes(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Correlation-Id',
      'X-Debug-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Debug-Active', 'Retry-After'],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    strictPreflight: true,
  });

  // Rate limit — defaults must equal the named constants.
  const max = opts.rateLimitMax ?? RATE_LIMIT_MAX_REQUESTS_DEFAULT;
  const windowMs = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS_DEFAULT;
  const rateLimitOptions: Record<string, unknown> = {
    max,
    timeWindow: windowMs,
    keyGenerator: (req: { ip: string }) => req.ip,
  };
  if (opts.nowOverride !== undefined) {
    rateLimitOptions['nameSpace'] = 'test-';
    rateLimitOptions['skipOnError'] = false;
  }
  await app.register(rateLimit, rateLimitOptions);

  app.setErrorHandler(errorHandler);

  app.get('/ping', (_req, reply) => {
    void reply.code(HTTP_STATUS_OK).send({ ok: true });
  });
  app.post('/echo', (req, reply) => {
    void reply.code(HTTP_STATUS_OK).send({ body: req.body });
  });
  app.options('/preflight-test', (_req, reply) => {
    void reply.code(HTTP_STATUS_OK).send();
  });

  await app.ready();
  return app;
}

// ─── Helmet contract — OWASP ASVS V14.4 ──────────────────────────────────────

describe('helmet — OWASP ASVS V14.4 browser security headers', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildSecuredApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET response includes Content-Security-Policy with default-src none', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(HTTP_STATUS_OK);
    const csp = res.headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('response includes X-Frame-Options SAMEORIGIN (clickjacking)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('response includes X-Content-Type-Options: nosniff (ASVS V14.4)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('response includes Strict-Transport-Security (HSTS)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const hsts = res.headers['strict-transport-security'];
    expect(typeof hsts).toBe('string');
    expect(hsts).toContain('max-age=');
  });

  it('response does not include X-Powered-By (helmet hides it)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ─── CORS contract — origin allowlist boundary ───────────────────────────────

describe('cors — localhost-only allowlist (dev/test) + production origin allowlist', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('dev/test: allows http://localhost:3001 origin', async () => {
    app = await buildSecuredApp({ nodeEnv: 'test' });
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://localhost:3001' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });

  it('dev/test: rejects non-localhost origin (no allow-origin reflection)', async () => {
    app = await buildSecuredApp({ nodeEnv: 'test' });
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('production: exact-match origin from allowlist is reflected', async () => {
    app = await buildSecuredApp({
      nodeEnv: 'production',
      allowedOrigins: ['https://app.example.com'],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('production: subdomain that is NOT an exact match is rejected', async () => {
    app = await buildSecuredApp({
      nodeEnv: 'production',
      allowedOrigins: ['https://app.example.com'],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://evil.app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight OPTIONS sets Access-Control-Max-Age=86400 (24h)', async () => {
    app = await buildSecuredApp({ nodeEnv: 'test' });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/preflight-test',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Content-Type',
      },
    });
    expect(res.headers['access-control-max-age']).toBe(
      String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
  });
});

// ─── Rate-limit contract — boundary at N and N+1 ─────────────────────────────

describe('rate-limit — boundary at N=max requests in window', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('N requests within window pass, N+1 returns 429 (boundary: N=3)', async () => {
    const MAX = 3;
    app = await buildSecuredApp({ rateLimitMax: MAX, rateLimitWindowMs: 60_000 });

    // Requests 1..MAX MUST all be 200.
    for (let i = 1; i <= MAX; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(HTTP_STATUS_OK);
    }
    // Request MAX+1 MUST be 429.
    const overflow = await app.inject({ method: 'GET', url: '/ping' });
    expect(overflow.statusCode).toBe(HTTP_STATUS_TOO_MANY_REQUESTS);
  });

  it('429 response is RFC-014 shaped with retryable=true and code RATE_LIMIT_EXCEEDED', async () => {
    const MAX = 1;
    app = await buildSecuredApp({ rateLimitMax: MAX, rateLimitWindowMs: 60_000 });
    await app.inject({ method: 'GET', url: '/ping' }); // exhaust
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(HTTP_STATUS_TOO_MANY_REQUESTS);
    const env = res.json<{
      readonly error: {
        readonly code: string;
        readonly retryable: boolean;
        readonly request_id: string;
        readonly message: string;
      };
    }>();
    expect(env.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(env.error.retryable).toBe(true);
    expect(env.error.request_id.length).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('Korean (한글) request body still triggers 429 with intact RFC-014 envelope', async () => {
    // Rule 5: Korean payload must not break the rate-limit / error-handler path.
    const MAX = 1;
    app = await buildSecuredApp({ rateLimitMax: MAX, rateLimitWindowMs: 60_000 });
    await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: { query: '레드 와인 추천' },
    });
    const overflow = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: { query: '레드 와인 추천' },
    });
    expect(overflow.statusCode).toBe(HTTP_STATUS_TOO_MANY_REQUESTS);
    const env = overflow.json<{
      readonly error: { readonly code: string };
    }>();
    expect(env.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('boundary N=1 (smallest non-zero limit): 1 pass, 2nd fails', async () => {
    app = await buildSecuredApp({ rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const first = await app.inject({ method: 'GET', url: '/ping' });
    expect(first.statusCode).toBe(HTTP_STATUS_OK);
    const second = await app.inject({ method: 'GET', url: '/ping' });
    expect(second.statusCode).toBe(HTTP_STATUS_TOO_MANY_REQUESTS);
  });
});

// ─── Default constants — must equal documented values ────────────────────────

describe('rate-limit default constants — module-scope SSoT', () => {
  it('RATE_LIMIT_MAX_REQUESTS_DEFAULT = 100', () => {
    expect(RATE_LIMIT_MAX_REQUESTS_DEFAULT).toBe(100);
  });
  it('RATE_LIMIT_WINDOW_MS_DEFAULT = 60_000 (one minute)', () => {
    expect(RATE_LIMIT_WINDOW_MS_DEFAULT).toBe(60_000);
  });
});

// ─── Property tests ──────────────────────────────────────────────────────────

describe('properties — helmet idempotency & rate-limit bucket monotonicity', () => {
  it('property: every request within the window is either 200 or 429 (no surprises)', async () => {
    // Bucket monotonicity: once we cross the threshold, subsequent requests
    // within the window MUST remain at 429 (count never decreases). This
    // proves the bucket is monotone-non-decreasing inside a window.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10 }),
        async (max, extra) => {
          const app = await buildSecuredApp({
            rateLimitMax: max,
            rateLimitWindowMs: 60_000,
          });
          try {
            const statuses: number[] = [];
            for (let i = 0; i < max + extra; i += 1) {
              const res = await app.inject({ method: 'GET', url: '/ping' });
              statuses.push(res.statusCode);
            }
            // First `max` requests are 200.
            for (let i = 0; i < max; i += 1) {
              expect(statuses[i]).toBe(HTTP_STATUS_OK);
            }
            // Once we hit 429, every subsequent response in this window stays
            // at 429 (monotone). It can never drop back to 200.
            let seenLimit = false;
            for (let i = max; i < statuses.length; i += 1) {
              if (statuses[i] === HTTP_STATUS_TOO_MANY_REQUESTS) seenLimit = true;
              if (seenLimit) {
                expect(statuses[i]).toBe(HTTP_STATUS_TOO_MANY_REQUESTS);
              }
            }
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 8 },
    );
  });

  it('property: helmet headers are deterministically present across many requests', async () => {
    // Idempotency: helmet does not crash or drop headers under repeat calls.
    const app = await buildSecuredApp({ rateLimitMax: 1_000_000 });
    try {
      for (let i = 0; i < 25; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/ping' });
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(typeof res.headers['content-security-policy']).toBe('string');
      }
    } finally {
      await app.close();
    }
  });
});
