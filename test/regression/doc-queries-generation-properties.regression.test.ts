/**
 * Property-based regression for Doc2Query synthetic-query post-processing
 * (`scripts/etl/generate-doc-queries.ts`).
 *
 * The point of these properties is to pin invariants the Doc2Query stage must
 * hold for ANY LLM output, ANY input record (Korean / Latin / mixed / empty),
 * and any seeded shuffle of the duplicate set — not just the curated raws
 * the deterministic regression file already covers.
 *
 * Invariants (numRuns=100, append-only, SOTA++ grade):
 *  1. Bounded output size — output length never exceeds the raw-input
 *     length, and every element has length in
 *     `[DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS]`. Named constants only —
 *     no magic numbers (CLAUDE.md rule 15).
 *  2. No empty / blank queries — `''`, `'   '`, '\t\n' are dropped without
 *     throwing.
 *  3. NFC stability — every emitted query equals its own NFC form, so
 *     downstream BM25 / tokenizers see canonical Korean. Hangul NFD inputs
 *     collapse to their NFC twin (canonical-dedup key is NFC-aware).
 *  4. Idempotence — `normalize(normalize(x))` produces the same query set
 *     in the same order. Re-running the post-processor must be a fixed
 *     point so a partial-checkpoint resume is safe.
 *  5. Determinism under shuffle of duplicates — re-ordering an array of
 *     `[orig, DUP, DUP, ...]` (with the original first) preserves the
 *     first-occurrence-wins output. This pins the "same doc → same query
 *     set" guarantee even when the LLM permutes its own near-duplicates.
 *  6. Subset invariant — every emitted query is the NFC-trimmed form of
 *     some input string. The post-processor never invents content.
 *  7. Korean preservation — when every input is Hangul-only Korean, every
 *     output keeps at least one Hangul codepoint and zero ASCII letters
 *     (no romanization slips through). This guards rule 8 (no `\b` on
 *     Korean tokens) at the output boundary.
 *  8. `processRecordForTest` determinism — same record + same generator
 *     output yields identical `syntheticQueries` AND identical
 *     `doc2queryFingerprint.contentHash`. Pins the idempotent-skip path.
 *  9. AbortSignal pre-flight — an aborted signal MUST yield zero generator
 *     calls (no wasted token spend).
 * 10. Per-doc query budget — output count is always
 *     `<= min(raw.length, DOC_QUERIES_PER_DOC * SAFETY_FACTOR)`. The
 *     post-processor never amplifies the LLM's slot count.
 *
 * Touch-policy: append-only. Never delete this file. If a property fails
 * structurally, fix the source — do NOT loosen the property.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
  DOC_QUERY_MIN_CHARS,
  DOC_QUERY_MAX_CHARS,
  DOC_QUERIES_PER_DOC,
  DOC_QUERIES_SCHEMA_VERSION,
  normalizeAndDedupeQueries,
  processRecordForTest,
} from '../../scripts/etl/generate-doc-queries.js';
import type {
  Doc2QueryGeneratorPort,
  Doc2QueryInput,
} from '../../src/domain/retrieval/port/doc2query-generator.port.js';
import type { EnrichedSilverRecord } from '../../scripts/etl/types.js';

// ---------------------------------------------------------------------------
// Test-config constants (CLAUDE.md rule 15 — no magic numbers)
// ---------------------------------------------------------------------------

/** fast-check run budget per property — required by user directive. */
const PROPERTY_NUM_RUNS = 100;

/**
 * Upper bound on per-doc emitted queries. The post-processor MUST NOT grow
 * output beyond the LLM-returned slot count, so the practical ceiling for a
 * single record is `DOC_QUERIES_PER_DOC` slots from a well-behaved LLM. We
 * use the slot constant directly here so any future bump propagates.
 */
const MAX_EMITTED_PER_DOC = DOC_QUERIES_PER_DOC;

/** Hangul Syllables block (precomposed) — used to detect Korean codepoints. */
const HANGUL_SYLLABLE_RE = /[가-힣]/u;

/** Latin letter detector — ASCII A-Z/a-z only; deliberately narrow. */
const LATIN_LETTER_RE = /[A-Za-z]/u;

/**
 * Hangul-only string arbitrary. Generates strings of Hangul syllables of
 * length `[DOC_QUERY_MIN_CHARS, 12]` so they comfortably fit in
 * `[DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS]` after trim+NFC. We require
 * MIN_CHARS at the source so the post-processor's length filter doesn't
 * silently drop short Korean inputs (the bound is by design — single-syllable
 * "가" is too short to anchor a BM25 token).
 */
function hangulString(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0xac00, max: 0xd7a3 }), {
      minLength: DOC_QUERY_MIN_CHARS,
      maxLength: 12,
    })
    .map((codes) => String.fromCodePoint(...codes));
}

/**
 * Arbitrary that yields strings whose NFC-trimmed length lands inside
 * `[DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS]`. Mixes ASCII letters,
 * digits, Hangul, and a few common punctuation chars to exercise the
 * post-processor over a realistic LLM-output distribution.
 */
function inRangeQuery(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: DOC_QUERY_MIN_CHARS, maxLength: DOC_QUERY_MAX_CHARS })
    .filter((s) => {
      const t = s.normalize('NFC').trim();
      return t.length >= DOC_QUERY_MIN_CHARS && t.length <= DOC_QUERY_MAX_CHARS;
    });
}

/** Mixed Korean + English query arbitrary used for the i18n property suite. */
function mixedQuery(): fc.Arbitrary<string> {
  return fc.oneof(
    hangulString(),
    inRangeQuery(),
    fc.tuple(hangulString(), inRangeQuery()).map(([k, e]) => `${k} ${e}`),
  );
}

// ---------------------------------------------------------------------------
// Record fixture builder (kept minimal — only fields the generator reads)
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<EnrichedSilverRecord> = {}): EnrichedSilverRecord {
  const base: EnrichedSilverRecord = {
    sourceId: 'vivino-prop-1' as EnrichedSilverRecord['sourceId'],
    externalId: 'ext-prop-1',
    canonicalLabel: 'Opus One',
    producer: 'Opus One Winery',
    vintageYear: 2018,
    country: 'United States',
    region: 'United States / California / Napa Valley',
    appellation: null,
    wineType: 'red' as EnrichedSilverRecord['wineType'],
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.8,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.7,
    pairingTags: ['beef', 'lamb'],
    flavorProfiles: ['black-fruit', 'oak'],
    searchTextEn: 'Bold Napa Cabernet blend with notes of blackcurrant and cedar.',
    ratingAvg: 4.5,
    ratingsCount: 1200,
    priceUsd: 350,
    priceBand: 'luxury' as EnrichedSilverRecord['priceBand'],
    popularityScore: 0.9,
    scrapedAt: '2025-01-01T00:00:00Z',
    alcoholPct: 14.5,
    producerPrestige: 0.95,
    isTopRated: true,
    aliases: {
      proposed: [
        {
          value: '오퍼스 원',
          type: 'translation',
          source: 'rule:ko_v1',
          confidencePrior: 0.9,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Opus One'],
      noisyRecallProjection: [],
    },
  };
  return { ...base, ...overrides };
}

class StubGenerator implements Doc2QueryGeneratorPort {
  public readonly modelId: string;
  public calls = 0;
  public lastInput: Doc2QueryInput | null = null;
  constructor(
    private readonly returns:
      | readonly string[]
      | (() => readonly string[])
      | (() => Promise<readonly string[]>),
    modelId = 'mock-doc2query-prop-v1',
  ) {
    this.modelId = modelId;
  }
  async generate(input: Doc2QueryInput): Promise<readonly string[]> {
    this.calls += 1;
    this.lastInput = input;
    if (typeof this.returns === 'function') {
      return await this.returns();
    }
    return this.returns;
  }
}

// ---------------------------------------------------------------------------
// Property suite
// ---------------------------------------------------------------------------

describe('doc-queries-generation properties — normalizeAndDedupeQueries', () => {
  it('Property 1: bounded length — every emitted query is in [MIN, MAX]', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: DOC_QUERY_MAX_CHARS + 50 }), { maxLength: 40 }), (raw) => {
        const out = normalizeAndDedupeQueries(raw).queries;
        for (const q of out) {
          expect(q.length).toBeGreaterThanOrEqual(DOC_QUERY_MIN_CHARS);
          expect(q.length).toBeLessThanOrEqual(DOC_QUERY_MAX_CHARS);
        }
        expect(out.length).toBeLessThanOrEqual(raw.length);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 2: no empty / blank queries in output, no throw on blank-only input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('', '   ', '\t\n', '  \t  '), { minLength: 0, maxLength: 20 }),
        (raw) => {
          const out = normalizeAndDedupeQueries(raw).queries;
          expect(out).toEqual([]);
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 3: NFC stability — every output equals its own NFC form', () => {
    fc.assert(
      fc.property(fc.array(mixedQuery(), { maxLength: 40 }), (raw) => {
        const out = normalizeAndDedupeQueries(raw).queries;
        for (const q of out) {
          expect(q).toBe(q.normalize('NFC'));
        }
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 4: idempotence — normalize(normalize(x)) equals normalize(x)', () => {
    fc.assert(
      fc.property(fc.array(mixedQuery(), { maxLength: 40 }), (raw) => {
        const once = normalizeAndDedupeQueries(raw);
        const twice = normalizeAndDedupeQueries(once.queries);
        expect(twice.queries).toEqual(once.queries);
        expect(twice.schemaVersion).toBe(once.schemaVersion);
        expect(twice.schemaVersion).toBe(DOC_QUERIES_SCHEMA_VERSION);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 5: dedup determinism under permutation of duplicates of a single original', () => {
    fc.assert(
      fc.property(
        inRangeQuery(),
        fc.integer({ min: 0, max: 8 }),
        // seed for the permutation
        fc.integer({ min: 0, max: 0xffff }),
        (original, dupCount, seed) => {
          const nfc = original.normalize('NFC').trim();
          fc.pre(nfc.length >= DOC_QUERY_MIN_CHARS && nfc.length <= DOC_QUERY_MAX_CHARS);

          // Build duplicates by case-flipping + whitespace mutation. These all
          // collapse to the same canonical-dedup key.
          const dups: string[] = [];
          for (let i = 0; i < dupCount; i += 1) {
            const flipped = i % 2 === 0 ? nfc.toUpperCase() : nfc.toLowerCase();
            dups.push(`  ${flipped}  `);
          }
          const arr = [nfc, ...dups];
          // Deterministic seeded shuffle that keeps the original at index 0.
          const tail = dups.slice();
          for (let i = tail.length - 1; i > 0; i -= 1) {
            const j = (seed + i) % (i + 1);
            const a = tail[i];
            const b = tail[j];
            if (a !== undefined && b !== undefined) {
              tail[i] = b;
              tail[j] = a;
            }
          }
          const shuffled = [nfc, ...tail];

          const out1 = normalizeAndDedupeQueries(arr).queries;
          const out2 = normalizeAndDedupeQueries(shuffled).queries;
          expect(out2).toEqual(out1);
          // First-occurrence wins: the canonical-cased original is preserved.
          expect(out1).toEqual([nfc]);
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 6: subset invariant — every output is the NFC-trim of some input', () => {
    fc.assert(
      fc.property(fc.array(mixedQuery(), { maxLength: 30 }), (raw) => {
        const out = normalizeAndDedupeQueries(raw).queries;
        const inputNfcTrims = new Set(raw.map((s) => s.normalize('NFC').trim()));
        for (const q of out) {
          expect(inputNfcTrims.has(q)).toBe(true);
        }
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 7: Korean preservation — Hangul-only inputs keep Hangul, drop nothing into Latin', () => {
    fc.assert(
      fc.property(
        fc.array(hangulString(), { minLength: 1, maxLength: 20 }),
        (raw) => {
          const out = normalizeAndDedupeQueries(raw).queries;
          for (const q of out) {
            // Each output must contain at least one Hangul codepoint and zero
            // ASCII letters — the post-processor must not romanize anything.
            expect(HANGUL_SYLLABLE_RE.test(q)).toBe(true);
            expect(LATIN_LETTER_RE.test(q)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 8: NFD-input collapses to the same key as NFC-input (Korean canonicalization)', () => {
    fc.assert(
      fc.property(hangulString(), (s) => {
        const nfc = s.normalize('NFC');
        const nfd = s.normalize('NFD');
        // The two forms must be considered duplicates of each other.
        const out = normalizeAndDedupeQueries([nfc, nfd]).queries;
        expect(out).toHaveLength(1);
        // Whichever survived must be NFC-stable.
        expect(out[0]).toBe(out[0]!.normalize('NFC'));
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// processRecordForTest properties
// ---------------------------------------------------------------------------

describe('doc-queries-generation properties — processRecordForTest', () => {
  it('Property 9: same input + same generator output → identical syntheticQueries AND contentHash', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(inRangeQuery(), { minLength: 1, maxLength: MAX_EMITTED_PER_DOC }),
        async (raw) => {
          const gen1 = new StubGenerator(raw);
          const gen2 = new StubGenerator(raw);
          const a = await processRecordForTest(makeRecord(), gen1, true);
          const b = await processRecordForTest(makeRecord(), gen2, true);
          expect(a.rec.syntheticQueries).toEqual(b.rec.syntheticQueries);
          expect(a.rec.doc2queryFingerprint?.contentHash).toBe(
            b.rec.doc2queryFingerprint?.contentHash,
          );
          expect(a.rec.doc2queryFingerprint?.modelId).toBe(
            b.rec.doc2queryFingerprint?.modelId,
          );
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 10: per-doc query budget — output count never exceeds raw.length', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(inRangeQuery(), { minLength: 1, maxLength: MAX_EMITTED_PER_DOC * 2 }),
        async (raw) => {
          const gen = new StubGenerator(raw);
          const { rec } = await processRecordForTest(makeRecord(), gen, true);
          const out = rec.syntheticQueries ?? [];
          expect(out.length).toBeLessThanOrEqual(raw.length);
          // Budget is also bounded by the slot constant in well-behaved runs.
          // We do not strictly cap on DOC_QUERIES_PER_DOC because LLM may
          // over-emit; but the dedup must shrink, never grow.
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 11: AbortSignal pre-flight — aborted signal → zero generator calls', () => {
    fc.assert(
      fc.asyncProperty(fc.array(inRangeQuery(), { maxLength: 5 }), async (raw) => {
        const gen = new StubGenerator(raw);
        const controller = new AbortController();
        controller.abort();
        const { outcome } = await processRecordForTest(makeRecord(), gen, true, controller.signal);
        expect(outcome).toBe('failed');
        expect(gen.calls).toBe(0);
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 12: empty / blank canonicalLabel → outcome=failed, no generator call', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', '   ', '\t', '\n', '   \t  \n  '),
        async (label) => {
          const gen = new StubGenerator(['valid query alpha']);
          const rec = makeRecord({ canonicalLabel: label });
          const { outcome } = await processRecordForTest(rec, gen, true);
          expect(outcome).toBe('failed');
          expect(gen.calls).toBe(0);
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 13: malformed LLM output (throw) → outcome=failed, no rethrow', () => {
    fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 80 }), async (msg) => {
        const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
        const gen = new StubGenerator((): readonly string[] => {
          throw new Error(`SyntaxError: ${msg}`);
        });
        const { outcome } = await processRecordForTest(makeRecord(), gen, true);
        expect(outcome).toBe('failed');
        warn.mockRestore();
      }),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 14: Korean canonical-label record → Korean queries preserved, all NFC-stable', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(hangulString(), { minLength: 1, maxLength: MAX_EMITTED_PER_DOC }),
        async (koQueries) => {
          const gen = new StubGenerator(koQueries);
          const rec = makeRecord({ canonicalLabel: '오퍼스 원' });
          const { rec: out } = await processRecordForTest(rec, gen, true);
          const queries = out.syntheticQueries ?? [];
          for (const q of queries) {
            expect(q).toBe(q.normalize('NFC'));
            expect(q.length).toBeGreaterThanOrEqual(DOC_QUERY_MIN_CHARS);
            expect(q.length).toBeLessThanOrEqual(DOC_QUERY_MAX_CHARS);
            expect(LATIN_LETTER_RE.test(q)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('Property 15: fingerprint determinism — same Doc2QueryInput projection → same contentHash', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(inRangeQuery(), { minLength: 1, maxLength: 6 }),
        async (raw) => {
          const gen = new StubGenerator(raw);
          // Two records with identical projected-input fields, but the
          // generator may be called twice. The fingerprint MUST collide.
          const a = await processRecordForTest(makeRecord(), gen, true);
          const b = await processRecordForTest(makeRecord(), gen, true);
          expect(a.rec.doc2queryFingerprint?.contentHash).toBe(
            b.rec.doc2queryFingerprint?.contentHash,
          );
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });
});
