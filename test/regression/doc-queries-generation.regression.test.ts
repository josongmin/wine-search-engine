/**
 * Regression: quality bounds + structural invariants on Doc2Query synthetic
 * queries produced by `scripts/etl/generate-doc-queries.ts`.
 *
 * Invariants pinned by this file:
 *   1. Length bounds — every emitted query has length in
 *      [DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS] (named consts, not magic).
 *   2. Determinism + dedup — duplicate raw queries (by canonical form) are
 *      emitted at most once; order is preserved (first occurrence wins).
 *   3. Schema versioning — processed output carries `schemaVersion = '1'` so
 *      downstream consumers can migrate safely.
 *   4. Korean preservation — Hangul payloads round-trip NFC-stable.
 *   5. Empty / malformed input — graceful skip, no throw.
 *   6. Generator call discipline — 1 generator invocation per record; aborted
 *      mid-batch makes no further calls.
 *
 * Append-only: never delete this file.
 */

import { describe, expect, it, vi } from 'vitest';
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
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<EnrichedSilverRecord> = {}): EnrichedSilverRecord {
  const base: EnrichedSilverRecord = {
    sourceId: 'vivino-test-1' as EnrichedSilverRecord['sourceId'],
    externalId: 'ext-1',
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
        { value: '오퍼스 원', type: 'translation', source: 'rule:ko_v1', confidencePrior: 0.9, needsReview: false },
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
    private readonly returns: readonly string[] | (() => readonly string[]) | (() => Promise<readonly string[]>),
    modelId = 'mock-doc2query-v1',
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
// 1. Named constants exist and have sane bounds (rule 15)
// ---------------------------------------------------------------------------

describe('doc-queries-generation: named quality constants', () => {
  it('exposes DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS, DOC_QUERIES_PER_DOC, DOC_QUERIES_SCHEMA_VERSION', () => {
    expect(typeof DOC_QUERY_MIN_CHARS).toBe('number');
    expect(typeof DOC_QUERY_MAX_CHARS).toBe('number');
    expect(typeof DOC_QUERIES_PER_DOC).toBe('number');
    expect(typeof DOC_QUERIES_SCHEMA_VERSION).toBe('string');
    expect(DOC_QUERY_MIN_CHARS).toBeGreaterThanOrEqual(1);
    expect(DOC_QUERY_MAX_CHARS).toBeGreaterThan(DOC_QUERY_MIN_CHARS);
    expect(DOC_QUERIES_PER_DOC).toBeGreaterThan(0);
    expect(DOC_QUERIES_SCHEMA_VERSION).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeAndDedupeQueries — pure helper
// ---------------------------------------------------------------------------

describe('normalizeAndDedupeQueries', () => {
  it('emits N records when LLM returns N valid queries', () => {
    const raw = ['Opus One Napa', 'cabernet blend napa', 'bold red wine pairing steak'];
    const result = normalizeAndDedupeQueries(raw);
    expect(result.queries).toHaveLength(3);
    expect(result.schemaVersion).toBe(DOC_QUERIES_SCHEMA_VERSION);
  });

  it('enforces length bounds [MIN, MAX]', () => {
    const tooShort = 'a'.repeat(DOC_QUERY_MIN_CHARS - 1);
    const tooLong = 'x'.repeat(DOC_QUERY_MAX_CHARS + 1);
    const justRight = 'opus one napa';
    const raw = [tooShort, tooLong, justRight];
    const result = normalizeAndDedupeQueries(raw);
    expect(result.queries).toEqual([justRight]);
    for (const q of result.queries) {
      expect(q.length).toBeGreaterThanOrEqual(DOC_QUERY_MIN_CHARS);
      expect(q.length).toBeLessThanOrEqual(DOC_QUERY_MAX_CHARS);
    }
  });

  it('JUST inside the bound is accepted; JUST outside is rejected (rule 6)', () => {
    const justInsideMin = 'a'.repeat(DOC_QUERY_MIN_CHARS);
    const justOutsideMin = 'b'.repeat(DOC_QUERY_MIN_CHARS - 1);
    const justInsideMax = 'c'.repeat(DOC_QUERY_MAX_CHARS);
    const justOutsideMax = 'd'.repeat(DOC_QUERY_MAX_CHARS + 1);
    const result = normalizeAndDedupeQueries([justInsideMin, justOutsideMin, justInsideMax, justOutsideMax]);
    expect(result.queries).toEqual([justInsideMin, justInsideMax]);
  });

  it('deduplicates by canonical form (case + whitespace insensitive)', () => {
    const raw = ['Opus One Napa', 'OPUS ONE NAPA', '  opus one  napa  ', 'opus one napa'];
    const result = normalizeAndDedupeQueries(raw);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toBe('Opus One Napa');
  });

  it('preserves Korean queries and is NFC-stable', () => {
    const nfc = '오퍼스 원 추천 와인';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const result = normalizeAndDedupeQueries([nfc, nfd]);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toBe(result.queries[0]!.normalize('NFC'));
    expect(result.queries[0]).toBe(nfc);
  });

  it('returns empty on empty input, does not throw', () => {
    expect(() => normalizeAndDedupeQueries([])).not.toThrow();
    expect(normalizeAndDedupeQueries([]).queries).toEqual([]);
  });

  it('skips empty / whitespace-only strings without throwing', () => {
    const result = normalizeAndDedupeQueries(['', '   ', '\t\n', 'opus one napa']);
    expect(result.queries).toEqual(['opus one napa']);
  });

  it('preserves first-occurrence order on dedup', () => {
    const raw = ['first query alpha', 'second query beta', 'FIRST QUERY ALPHA', 'third query gamma'];
    const result = normalizeAndDedupeQueries(raw);
    expect(result.queries).toEqual(['first query alpha', 'second query beta', 'third query gamma']);
  });
});

// ---------------------------------------------------------------------------
// 3. processRecordForTest — LLM mock integration
// ---------------------------------------------------------------------------

describe('processRecordForTest: LLM mock contract', () => {
  it('LLM returns N queries → N records emitted on the record', async () => {
    const queries = Array.from({ length: DOC_QUERIES_PER_DOC }, (_, i) => `query slot ${i + 1}`);
    const gen = new StubGenerator(queries);
    const { rec, outcome } = await processRecordForTest(makeRecord(), gen, true);
    expect(outcome).toBe('generated');
    expect(rec.syntheticQueries).toHaveLength(DOC_QUERIES_PER_DOC);
    expect(rec.doc2queryFingerprint?.modelId).toBe('mock-doc2query-v1');
  });

  it('Korean wine doc → Korean queries generated, NFC-stable', async () => {
    const koQueries = [
      '오퍼스 원 추천',
      '나파 카베르네 와인',
      '오퍼스 원 추천', // duplicate
      '스테이크와 어울리는 와인',
    ];
    const gen = new StubGenerator(koQueries);
    const rec = makeRecord({ canonicalLabel: '오퍼스 원' });
    const { rec: out } = await processRecordForTest(rec, gen, true);
    expect(out.syntheticQueries).toBeDefined();
    expect(out.syntheticQueries!.length).toBeLessThan(koQueries.length); // dedup ran
    for (const q of out.syntheticQueries!) {
      expect(q).toBe(q.normalize('NFC'));
      expect(q.length).toBeGreaterThanOrEqual(DOC_QUERY_MIN_CHARS);
      expect(q.length).toBeLessThanOrEqual(DOC_QUERY_MAX_CHARS);
    }
  });

  it('empty canonicalLabel → empty queries, no throw, outcome=failed', async () => {
    const gen = new StubGenerator([]);
    const rec = makeRecord({ canonicalLabel: '' });
    await expect(processRecordForTest(rec, gen, true)).resolves.toBeDefined();
    const { outcome } = await processRecordForTest(rec, gen, true);
    expect(outcome).toBe('failed');
  });

  it('malformed LLM output (throw) → graceful skip, outcome=failed, no rethrow', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gen = new StubGenerator((): readonly string[] => {
      throw new Error('SyntaxError: Unexpected token in JSON');
    });
    const { outcome } = await processRecordForTest(makeRecord(), gen, true);
    expect(outcome).toBe('failed');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('determinism: same input + same generator output → same processed queries', async () => {
    const queries = ['alpha query one', 'beta query two', 'gamma query three'];
    const gen1 = new StubGenerator(queries);
    const gen2 = new StubGenerator(queries);
    const a = await processRecordForTest(makeRecord(), gen1, true);
    const b = await processRecordForTest(makeRecord(), gen2, true);
    expect(a.rec.syntheticQueries).toEqual(b.rec.syntheticQueries);
    expect(a.rec.doc2queryFingerprint?.contentHash).toBe(b.rec.doc2queryFingerprint?.contentHash);
  });

  it('LLM call count: 1 generator call per processed record', async () => {
    const gen = new StubGenerator(['one query', 'two query']);
    await processRecordForTest(makeRecord(), gen, true);
    expect(gen.calls).toBe(1);
  });

  it('mixed Korean + English batch is processed correctly', async () => {
    const queries = ['오퍼스 원 와인', 'Opus One Napa Cabernet', '오퍼스 원 와인', 'OPUS ONE NAPA CABERNET'];
    const gen = new StubGenerator(queries);
    const { rec } = await processRecordForTest(makeRecord(), gen, true);
    expect(rec.syntheticQueries).toEqual(['오퍼스 원 와인', 'Opus One Napa Cabernet']);
  });
});

// ---------------------------------------------------------------------------
// 4. AbortSignal cooperation (worker-level invariant)
// ---------------------------------------------------------------------------

describe('processRecordForTest: AbortSignal cooperation', () => {
  it('aborted before generation → no LLM call, outcome=failed', async () => {
    const gen = new StubGenerator(['should never see this']);
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await processRecordForTest(makeRecord(), gen, true, controller.signal);
    expect(outcome).toBe('failed');
    expect(gen.calls).toBe(0);
  });

  it('non-aborted signal → generator is called normally', async () => {
    const gen = new StubGenerator(['valid query one', 'valid query two']);
    const controller = new AbortController();
    const { outcome } = await processRecordForTest(makeRecord(), gen, true, controller.signal);
    expect(outcome).toBe('generated');
    expect(gen.calls).toBe(1);
  });
});
