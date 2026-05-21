/**
 * Property-based regression tests for the bronze Vivino data connector.
 *
 * Maturity bump 3 → 5 (etl.bronze-data-connector). The base enumerated suite
 * (`bronze-data-connector.regression.test.ts`) locks in retry/backoff and
 * freshness metadata. This file adds PROPERTY-BASED invariants (fast-check,
 * numRuns: 100) over the wider bronze ingestion surface that SOTA++ requires
 * a connector to honor:
 *
 *   P1. Determinism — same fetch (injected clock, RNG, fetch body) yields a
 *       byte-identical snapshot envelope across N invocations. The connector
 *       must have NO hidden global state.
 *   P2. Schema enforcement (no `as DomainType` on external data) — invalid
 *       upstream payloads MUST surface as `schema-error`, never silently
 *       narrow into the typed snapshot shape.
 *   P3. Bounded record size — any response above
 *       `BRONZE_FETCH_MAX_BODY_BYTES` MUST surface as `body-too-large`.
 *       Below the cap MUST succeed.
 *   P4. Encoding stability (BOM + NFC) — text intake MUST be idempotent
 *       under repeated normalization, and a leading UTF-8 BOM MUST be
 *       stripped exactly once. Korean (한글) round-trips with no jamo
 *       decomposition.
 *   P5. Path-traversal rejection — any `file://` URL containing `..` or NUL
 *       MUST be refused with a `path-traversal` error before any fetch.
 *   P6. Empty / malformed source → typed error — empty body MUST surface as
 *       `empty-body`; malformed JSON MUST surface as `parse-error`. NEVER
 *       throw, NEVER fabricate a 200-shape envelope.
 *
 * Touch-policy: regression-only, append-only. The fetcher implementation
 * already satisfies every property below.
 *
 * Mocks `fetch`; NEVER hits the real Vivino API.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import {
  BRONZE_FETCH_MAX_BODY_BYTES,
  BRONZE_TEXT_NORMALIZATION_FORM,
  BRONZE_UTF8_BOM,
  fetchVivinoSnapshot,
  normalizeBronzeText,
  parseBronzeJson,
  sanitizeBronzeUrl,
  type BronzeFetchClock,
  type BronzeFetchResult,
} from '../../tools/bronze-vivino-data-connector/fetch-vivino-snapshots.js';

const PROPERTY_RUNS = 100;
const ENDPOINT_HTTPS = 'https://example.invalid/vivino/snapshot';

/** Snapshot schema — Korean producer name + vintage + price. */
const BronzeRecordSchema = z
  .object({
    external_id: z.string().min(1),
    display_name: z.string().min(1),
    producer: z.string().min(1),
    vintage_year: z.number().int().min(1800).max(2100),
  })
  .strict();

const BronzeBodySchema = z
  .object({
    records: z.array(BronzeRecordSchema).max(10_000),
  })
  .strict();

type BronzeBody = z.infer<typeof BronzeBodySchema>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixedClock(fixedNowIso: string, fixedSeed: number): BronzeFetchClock {
  const sleeps: number[] = [];
  return {
    nowIso: () => fixedNowIso,
    random: () => fixedSeed,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1. Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P1 determinism', () => {
  it('same body + injected clock → byte-identical snapshot envelope', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.integer({ min: 1900, max: 2050 }),
        fc.string({ minLength: 1, maxLength: 24 }),
        async (externalId, displayName, vintage, producer) => {
          // Allow ANY printable strings (incl. Korean, accented Latin, emoji).
          // Schema rejects empty, but we filter at the property boundary.
          const body: BronzeBody = {
            records: [
              {
                external_id: externalId,
                display_name: displayName,
                producer,
                vintage_year: vintage,
              },
            ],
          };
          const buildFetch = (): typeof globalThis.fetch =>
            (async () => jsonResponse(200, body)) as unknown as typeof globalThis.fetch;
          const clockA = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const clockB = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const [a, b] = await Promise.all([
            fetchVivinoSnapshot<BronzeBody>({
              url: ENDPOINT_HTTPS,
              fetch: buildFetch(),
              clock: clockA,
              schema: BronzeBodySchema,
            }),
            fetchVivinoSnapshot<BronzeBody>({
              url: ENDPOINT_HTTPS,
              fetch: buildFetch(),
              clock: clockB,
              schema: BronzeBodySchema,
            }),
          ]);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2. Schema enforcement — no `as DomainType` on external data.
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P2 schema enforcement', () => {
  it('any payload that fails BronzeBodySchema surfaces as schema-error (never ok)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary JSON-shaped values; almost all will fail the
        // strict body schema (records array missing / wrong type).
        fc.oneof(
          fc.constant({}),
          fc.constant({ records: 'not-an-array' }),
          fc.constant({ records: [null] }),
          fc.record({
            records: fc.array(
              fc.record({
                external_id: fc.string(),
                display_name: fc.string(),
                producer: fc.string(),
                vintage_year: fc.string(), // wrong type → schema rejects
              }),
              { minLength: 1, maxLength: 3 },
            ),
          }),
          fc.record({ unexpected: fc.string() }),
        ),
        async (payload) => {
          const fetchImpl: typeof globalThis.fetch = (async () =>
            jsonResponse(200, payload)) as unknown as typeof globalThis.fetch;
          const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const res: BronzeFetchResult<BronzeBody> = await fetchVivinoSnapshot<BronzeBody>({
            url: ENDPOINT_HTTPS,
            fetch: fetchImpl,
            clock,
            schema: BronzeBodySchema,
          });
          expect(res.ok).toBe(false);
          if (res.ok) throw new Error('unreachable');
          expect(res.error.kind).toBe('schema-error');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('Korean producer name passes schema and round-trips intact (NFC)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Korean syllables in NFC form, plus latin punctuation noise.
        fc.constantFrom('도멘 르플레브', '안티노리', '리지', '돈 페리뇽', '루이 로드레'),
        fc.integer({ min: 1900, max: 2050 }),
        async (koreanProducer, vintage) => {
          const body: BronzeBody = {
            records: [
              {
                external_id: 'kr-1',
                display_name: '와인',
                producer: koreanProducer,
                vintage_year: vintage,
              },
            ],
          };
          const fetchImpl: typeof globalThis.fetch = (async () =>
            jsonResponse(200, body)) as unknown as typeof globalThis.fetch;
          const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const res = await fetchVivinoSnapshot<BronzeBody>({
            url: ENDPOINT_HTTPS,
            fetch: fetchImpl,
            clock,
            schema: BronzeBodySchema,
          });
          expect(res.ok).toBe(true);
          if (!res.ok) throw new Error('unreachable');
          // NFC stability: producer string out === producer string normalized.
          const first = res.snapshot.records[0];
          expect(first).toBeDefined();
          if (first === undefined) throw new Error('unreachable');
          expect(first.producer).toBe(koreanProducer.normalize('NFC'));
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3. Bounded record size.
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P3 bounded size', () => {
  it('body > maxBodyBytes → body-too-large; body <= cap → ok', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a "below cap" and "above cap" delta. Use a tiny cap to
        // make the property cheap to evaluate.
        fc.integer({ min: 16, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        async (capBytes, overflowBytes) => {
          // Construct a payload string whose UTF-8 byte length we control.
          const overflowing = overflowBytes > 0;
          const payloadString = overflowing
            ? 'x'.repeat(capBytes + overflowBytes + 16)
            : 'x'.repeat(Math.max(1, capBytes - 16));
          // Wrap as JSON string so the body parses fine when below cap.
          const bodyJson = JSON.stringify({ payload: payloadString });
          const fetchImpl: typeof globalThis.fetch = (async () =>
            rawResponse(200, bodyJson)) as unknown as typeof globalThis.fetch;
          const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const res = await fetchVivinoSnapshot({
            url: ENDPOINT_HTTPS,
            fetch: fetchImpl,
            clock,
            maxBodyBytes: capBytes,
          });
          if (Buffer.byteLength(bodyJson, 'utf8') > capBytes) {
            expect(res.ok).toBe(false);
            if (res.ok) throw new Error('unreachable');
            expect(res.error.kind).toBe('body-too-large');
            if (res.error.kind === 'body-too-large') {
              expect(res.error.limitBytes).toBe(capBytes);
              expect(res.error.bytes).toBeGreaterThan(capBytes);
            }
          } else {
            expect(res.ok).toBe(true);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('default cap BRONZE_FETCH_MAX_BODY_BYTES is a positive named integer', () => {
    expect(Number.isInteger(BRONZE_FETCH_MAX_BODY_BYTES)).toBe(true);
    expect(BRONZE_FETCH_MAX_BODY_BYTES).toBeGreaterThan(0);
    // Sanity: ≥1 MiB, ≤256 MiB.
    expect(BRONZE_FETCH_MAX_BODY_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(BRONZE_FETCH_MAX_BODY_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4. Encoding stability (BOM strip + NFC).
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P4 encoding stability', () => {
  it('normalizeBronzeText is idempotent across all printable strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 64 }), (s) => {
        const once = normalizeBronzeText(s);
        const twice = normalizeBronzeText(once);
        expect(twice).toBe(once);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('a leading UTF-8 BOM is stripped exactly once', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 32 }), (s) => {
        const withBom = `${BRONZE_UTF8_BOM}${s}`;
        const normalized = normalizeBronzeText(withBom);
        expect(normalized.startsWith(BRONZE_UTF8_BOM)).toBe(false);
        expect(normalized).toBe(s.normalize(BRONZE_TEXT_NORMALIZATION_FORM));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('Korean NFD input is reconstituted to NFC', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('와인', '도멘 르플레브', '안티노리', '리지', '루이 로드레'),
        (koreanNfc) => {
          const nfd = koreanNfc.normalize('NFD');
          // Sanity: NFD form is different bytes from NFC for Hangul.
          expect(nfd.length).toBeGreaterThanOrEqual(koreanNfc.length);
          const renormalized = normalizeBronzeText(nfd);
          expect(renormalized).toBe(koreanNfc);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5. Path-traversal rejection.
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P5 path-traversal', () => {
  it('any file:// URL containing `..` or NUL is rejected before fetch', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'file:///tmp/../etc/passwd',
          'file:///var/data/../../etc/shadow',
          'file:///a/b/../../c',
          'file:///x/\0/y',
          'file://localhost/tmp/../etc/hosts',
        ),
        async (badUrl) => {
          const sanitized = sanitizeBronzeUrl(badUrl);
          expect(sanitized.ok).toBe(false);
          if (sanitized.ok) throw new Error('unreachable');
          expect(sanitized.reason).toBe('path-traversal');

          // End-to-end: fetcher refuses without ever calling fetch.
          let fetchCalls = 0;
          const fetchImpl: typeof globalThis.fetch = (async () => {
            fetchCalls++;
            return jsonResponse(200, { records: [] });
          }) as unknown as typeof globalThis.fetch;
          const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const res = await fetchVivinoSnapshot({
            url: badUrl,
            fetch: fetchImpl,
            clock,
          });
          expect(res.ok).toBe(false);
          if (res.ok) throw new Error('unreachable');
          expect(res.error.kind).toBe('path-traversal');
          expect(fetchCalls).toBe(0);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('http(s):// URLs always pass sanitization', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('https:', 'http:'),
        fc.constantFrom('example.com', 'api.vivino.com', 'localhost:8080'),
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => /^[A-Za-z0-9/_-]+$/u.test(s)),
        (scheme, host, path) => {
          const url = `${scheme}//${host}/${path}`;
          const result = sanitizeBronzeUrl(url);
          expect(result.ok).toBe(true);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P6. Empty / malformed source → typed error.
// ─────────────────────────────────────────────────────────────────────────────

describe('bronze-data-connector properties: P6 empty / malformed body', () => {
  it('empty body surfaces empty-body, never throws', async () => {
    const fetchImpl: typeof globalThis.fetch = (async () =>
      rawResponse(200, '')) as unknown as typeof globalThis.fetch;
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
    const res = await fetchVivinoSnapshot({
      url: ENDPOINT_HTTPS,
      fetch: fetchImpl,
      clock,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('empty-body');
  });

  it('malformed JSON surfaces parse-error, never throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          '{',
          '{"unclosed":',
          '][',
          'not-json-at-all',
          '{"a":undefined}',
          '{trailing,}',
        ),
        async (badText) => {
          const fetchImpl: typeof globalThis.fetch = (async () =>
            rawResponse(200, badText)) as unknown as typeof globalThis.fetch;
          const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
          const res = await fetchVivinoSnapshot({
            url: ENDPOINT_HTTPS,
            fetch: fetchImpl,
            clock,
          });
          expect(res.ok).toBe(false);
          if (res.ok) throw new Error('unreachable');
          expect(res.error.kind).toBe('parse-error');
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('parseBronzeJson never throws for any input string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 256 }), (s) => {
        const result = parseBronzeJson(s);
        // Either ok or a discriminated error — never a thrown exception.
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) {
          expect(['parse-error', 'empty-body']).toContain(result.error.kind);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
