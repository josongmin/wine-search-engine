/**
 * Regression: Tier 1.1 Wikidata grape backfill ETL — behavioural contract.
 *
 * Why this is a regression test:
 *  - Append-only per CLAUDE.md regression discipline.
 *  - The ETL must NEVER overwrite Vivino-sourced grapes (rule 11 / SSoT) —
 *    a silent overwrite would replace high-confidence varietal-parsed data
 *    with lower-confidence Wikidata aggregate data and degrade index
 *    quality.
 *  - 429 backoff is a Wikidata usage-policy concern: if the retry path
 *    silently regresses, the public IP gets temp-banned and the entire
 *    backfill stalls.
 *  - Cache schema is on-disk state shared across runs — its JSONL shape
 *    is locked in by this test.
 *
 * No live network calls — all `fetch` invocations are mocked.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CacheEntrySchema,
  DEFAULT_USER_AGENT,
  FUZZY_MATCH_THRESHOLD,
  SPARQL_MAX_REQUESTS_PER_SECOND,
  SPARQL_MIN_GAP_MS,
  appendCacheEntry,
  applyGrapesToRecord,
  buildExactLabelQuery,
  buildFuzzyLabelQuery,
  buildProducerToken,
  computeBackoffMs,
  decideGrapesForRecord,
  diceSimilarity,
  extractQid,
  loadCache,
  parseSparqlGrapes,
  postSparql,
  runBackfill,
  sparqlEscapeLiteral,
  stripTrailingVintage,
  type CacheEntry,
  type FetchLike,
  type SilverRecordLike,
} from '../../tools/wikidata-backfill/grape-backfill.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/sparql-results+json' },
  });
}

function makeSparqlBody(
  rows: ReadonlyArray<{ wineQid: string; wineLabel?: string; grapeLabel: string }>,
): unknown {
  return {
    head: { vars: ['wine', 'wineLabel', 'grapeLabel', 'grape'] },
    results: {
      bindings: rows.map((r) => ({
        wine: { type: 'uri', value: `http://www.wikidata.org/entity/${r.wineQid}` },
        ...(r.wineLabel != null
          ? { wineLabel: { type: 'literal', value: r.wineLabel } }
          : {}),
        grapeLabel: { type: 'literal', value: r.grapeLabel },
        grape: {
          type: 'uri',
          value: `http://www.wikidata.org/entity/Q-grape-${r.grapeLabel}`,
        },
      })),
    },
  };
}

function silverRecord(
  overrides: Partial<SilverRecordLike> = {},
): SilverRecordLike {
  return {
    externalId: 'vivino-12345',
    canonicalLabel: 'Château Margaux 2015',
    producer: 'Château Margaux',
    vintageYear: 2015,
    region: 'Bordeaux',
    appellation: 'Margaux',
    grapes: [],
    grapePrimary: null,
    searchTextEn: 'A first growth Bordeaux from Margaux.',
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wikidata-backfill-test-'));
}

async function rmTempDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('stripTrailingVintage removes 4-digit years between 1800 and 2999', () => {
    expect(stripTrailingVintage('Château Margaux 2015')).toBe('Château Margaux');
    expect(stripTrailingVintage('Penfolds Grange 1998')).toBe('Penfolds Grange');
    expect(stripTrailingVintage('Sassicaia 1799')).toBe('Sassicaia 1799'); // pre-1800 left intact
    expect(stripTrailingVintage('Opus One')).toBe('Opus One');
    expect(stripTrailingVintage('Wine 3000')).toBe('Wine 3000'); // post-2999 left intact
  });

  it('sparqlEscapeLiteral escapes quotes and strips backslashes', () => {
    expect(sparqlEscapeLiteral('La "Tâche"')).toBe('La \\"Tâche\\"');
    expect(sparqlEscapeLiteral('a\\b')).toBe('ab');
  });

  it('buildProducerToken normalises diacritics and caps length at 30', () => {
    expect(buildProducerToken('Château Margaux')).toBe('chateau margaux');
    expect(buildProducerToken("D'Yquem")).toBe('d yquem');
    const long = 'A'.repeat(60);
    const token = buildProducerToken(long);
    expect(token.length).toBe(30);
  });

  it('buildExactLabelQuery embeds the escaped label inline', () => {
    const q = buildExactLabelQuery('Château Pétrus');
    expect(q).toContain('"Château Pétrus"@en');
    expect(q).toContain('wdt:P186');
    expect(q).toContain('wdt:P31/wdt:P279* wd:Q3327547');
    expect(q).toContain('LIMIT 10');
  });

  it('buildFuzzyLabelQuery uses CONTAINS over LCASE label', () => {
    const q = buildFuzzyLabelQuery('chateau petrus');
    expect(q).toContain('CONTAINS(LCASE(STR(?lbl)), "chateau petrus")');
    expect(q).toContain('wdt:P186');
  });

  it('extractQid pulls the Q-id from a wikidata entity URI', () => {
    expect(extractQid('http://www.wikidata.org/entity/Q12345')).toBe('Q12345');
    expect(extractQid('http://other/entity/Q1')).toBe('Q1');
    expect(extractQid(undefined)).toBeNull();
    expect(extractQid('http://example.com/notaqid')).toBeNull();
  });

  it('diceSimilarity gives 1 for identical strings and ~0 for unrelated', () => {
    expect(diceSimilarity('cabernet sauvignon', 'cabernet sauvignon')).toBe(1);
    expect(diceSimilarity('', '')).toBe(1);
    expect(diceSimilarity('foo', 'bar')).toBeLessThan(0.2);
    expect(diceSimilarity('chateau margaux', 'chateau margaux 2015')).toBeGreaterThan(0.7);
  });

  it('SPARQL_MIN_GAP_MS is derived from the 5 req/sec ceiling', () => {
    expect(SPARQL_MAX_REQUESTS_PER_SECOND).toBe(5);
    expect(SPARQL_MIN_GAP_MS).toBeGreaterThanOrEqual(200);
  });

  it('computeBackoffMs follows base * 2^attempt with a cap', () => {
    expect(computeBackoffMs(0)).toBe(500);
    expect(computeBackoffMs(1)).toBe(1000);
    expect(computeBackoffMs(2)).toBe(2000);
    expect(computeBackoffMs(10)).toBe(30_000); // capped
  });
});

// ---------------------------------------------------------------------------
// parseSparqlGrapes
// ---------------------------------------------------------------------------

describe('parseSparqlGrapes', () => {
  it('extracts grape names correctly from a multi-row response', () => {
    const body = makeSparqlBody([
      { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Cabernet Sauvignon' },
      { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Merlot' },
      { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Cabernet Franc' },
    ]);
    const parsed = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    // Validate via Zod path:
    const result = parseSparqlGrapes(
      {
        head: { vars: ['wine', 'grapeLabel'] },
        results: {
          bindings: (
            (parsed['results'] as { bindings: Array<Record<string, unknown>> }).bindings
          ),
        },
      },
      'Château Margaux',
    );
    expect(result.qid).toBe('Q123');
    expect(result.grapes).toEqual(['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc']);
  });

  it('returns empty when bindings are empty', () => {
    const parsed = parseSparqlGrapes({ results: { bindings: [] } }, 'Anything');
    expect(parsed.grapes).toEqual([]);
    expect(parsed.qid).toBeNull();
  });

  it('deduplicates repeated grape labels per wine', () => {
    const body = makeSparqlBody([
      { wineQid: 'Q9', wineLabel: 'Petrus', grapeLabel: 'Merlot' },
      { wineQid: 'Q9', wineLabel: 'Petrus', grapeLabel: 'Merlot' },
    ]);
    const result = parseSparqlGrapes(body as never, 'Petrus');
    expect(result.grapes).toEqual(['Merlot']);
  });

  it('chooses the QID with the best label similarity on multi-wine results', () => {
    const body = makeSparqlBody([
      { wineQid: 'Q11111', wineLabel: 'Totally Unrelated Wine', grapeLabel: 'Tempranillo' },
      { wineQid: 'Q22222', wineLabel: 'Château Margaux', grapeLabel: 'Cabernet Sauvignon' },
    ]);
    const result = parseSparqlGrapes(body as never, 'Château Margaux');
    expect(result.qid).toBe('Q22222');
    expect(result.grapes).toEqual(['Cabernet Sauvignon']);
  });
});

// ---------------------------------------------------------------------------
// postSparql — rate-limit + retry
// ---------------------------------------------------------------------------

describe('postSparql', () => {
  it('sends an exact-label query and parses a happy-path response', async () => {
    const body = makeSparqlBody([
      { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Cabernet Sauvignon' },
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => makeJsonResponse(body));
    const sleepFn = vi.fn(async () => {});
    const resp = await postSparql('SELECT ?wine WHERE { }', {
      endpoint: 'https://wikidata.test/sparql',
      userAgent: DEFAULT_USER_AGENT,
      fetchFn,
      minGapMs: 0,
      lastRequestRef: { ms: 0 },
      sleepFn,
    });
    expect(resp.results?.bindings.length).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = fetchFn.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['User-Agent']).toContain(
      'wine-search-engine-grape-backfill',
    );
    expect((init.headers as Record<string, string>)['Accept']).toBe(
      'application/sparql-results+json',
    );
    expect(init.method).toBe('POST');
  });

  it('retries on 429 with exponential backoff and eventually succeeds', async () => {
    let calls = 0;
    const success = makeSparqlBody([
      { wineQid: 'Q1', wineLabel: 'X', grapeLabel: 'Pinot Noir' },
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('rate limited', { status: 429 });
      }
      return makeJsonResponse(success);
    });
    const sleepCalls: number[] = [];
    const sleepFn = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const resp = await postSparql('Q', {
      endpoint: 'https://wikidata.test/sparql',
      userAgent: DEFAULT_USER_AGENT,
      fetchFn,
      minGapMs: 0,
      lastRequestRef: { ms: 0 },
      sleepFn,
      maxRetries: 4,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Two retries → two backoff sleeps at attempts 0 and 1.
    const backoffs = sleepCalls.filter((ms) => ms > 0);
    expect(backoffs).toEqual([500, 1000]);
    expect(resp.results?.bindings.length).toBe(1);
  });

  it('exhausts retries on persistent 5xx and throws', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response('boom', { status: 503 }),
    );
    const sleepFn = vi.fn(async () => {});
    await expect(
      postSparql('Q', {
        endpoint: 'https://wikidata.test/sparql',
        userAgent: DEFAULT_USER_AGENT,
        fetchFn,
        minGapMs: 0,
        lastRequestRef: { ms: 0 },
        sleepFn,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/SPARQL transport failure/);
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('enforces a minimum gap between consecutive requests', async () => {
    const body = makeSparqlBody([
      { wineQid: 'Q1', wineLabel: 'X', grapeLabel: 'Syrah' },
    ]);
    const fetchFn = vi.fn<FetchLike>(async () => makeJsonResponse(body));
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };
    const ref = { ms: Date.now() };
    await postSparql('Q', {
      endpoint: 'https://wikidata.test/sparql',
      userAgent: DEFAULT_USER_AGENT,
      fetchFn,
      minGapMs: 250,
      lastRequestRef: ref,
      sleepFn,
    });
    // The very first call should have invoked sleep with a positive value
    // because lastRequestRef.ms was "now-ish".
    const initialSleep = sleepCalls.find((ms) => ms > 0);
    expect(initialSleep).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// decideGrapesForRecord — orchestration
// ---------------------------------------------------------------------------

describe('decideGrapesForRecord', () => {
  it('phase-1 exact match returns grapes and qid', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      makeJsonResponse(
        makeSparqlBody([
          {
            wineQid: 'Q123',
            wineLabel: 'Château Margaux',
            grapeLabel: 'Cabernet Sauvignon',
          },
          { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Merlot' },
        ]),
      ),
    );
    const decision = await decideGrapesForRecord(
      {
        canonicalLabel: 'Château Margaux 2015',
        producer: 'Château Margaux',
        vintageYear: 2015,
      },
      {
        endpoint: 'https://wikidata.test/sparql',
        userAgent: DEFAULT_USER_AGENT,
        fetchFn,
        minGapMs: 0,
        lastRequestRef: { ms: 0 },
        sleepFn: async () => {},
      },
    );
    expect(decision.wikidataQid).toBe('Q123');
    expect(decision.grapes).toEqual(['Cabernet Sauvignon', 'Merlot']);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('falls back to fuzzy match when exact yields no rows', async () => {
    let call = 0;
    const fetchFn = vi.fn<FetchLike>(async () => {
      call += 1;
      if (call === 1) {
        return makeJsonResponse({ results: { bindings: [] } });
      }
      return makeJsonResponse(
        makeSparqlBody([
          { wineQid: 'Q999', wineLabel: 'Château Margaux', grapeLabel: 'Cabernet Sauvignon' },
        ]),
      );
    });
    const decision = await decideGrapesForRecord(
      {
        canonicalLabel: 'Château Margaux 2015',
        producer: 'Château Margaux',
        vintageYear: 2015,
      },
      {
        endpoint: 'https://wikidata.test/sparql',
        userAgent: DEFAULT_USER_AGENT,
        fetchFn,
        minGapMs: 0,
        lastRequestRef: { ms: 0 },
        sleepFn: async () => {},
      },
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(decision.wikidataQid).toBe('Q999');
    expect(decision.grapes).toContain('Cabernet Sauvignon');
  });

  it('rejects a fuzzy candidate below FUZZY_MATCH_THRESHOLD', async () => {
    let call = 0;
    const fetchFn = vi.fn<FetchLike>(async () => {
      call += 1;
      if (call === 1) {
        return makeJsonResponse({ results: { bindings: [] } });
      }
      return makeJsonResponse(
        makeSparqlBody([
          // Completely different wine that happens to share the producer token.
          {
            wineQid: 'Q88888',
            wineLabel: 'Château Margaux Pavillon Rouge 1985 Library Reserve Limited Edition',
            grapeLabel: 'Wrong Grape',
          },
        ]),
      );
    });
    const decision = await decideGrapesForRecord(
      {
        canonicalLabel: 'Margaux 2015',
        producer: 'Château Margaux',
        vintageYear: 2015,
      },
      {
        endpoint: 'https://wikidata.test/sparql',
        userAgent: DEFAULT_USER_AGENT,
        fetchFn,
        minGapMs: 0,
        lastRequestRef: { ms: 0 },
        sleepFn: async () => {},
      },
    );
    expect(decision.wikidataQid).toBeNull();
    expect(decision.grapes).toEqual([]);
    expect(FUZZY_MATCH_THRESHOLD).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// applyGrapesToRecord — no-overwrite invariant
// ---------------------------------------------------------------------------

describe('applyGrapesToRecord', () => {
  it('does NOT overwrite existing non-empty varietal-parsed grapes', () => {
    const rec = silverRecord({
      grapes: ['Sangiovese'],
      grapePrimary: 'Sangiovese',
    });
    const after = applyGrapesToRecord(rec, ['Cabernet Sauvignon', 'Merlot']);
    expect(after).toBe(rec); // referential equality — no mutation
    expect(after.grapes).toEqual(['Sangiovese']);
    expect(after.grapePrimary).toBe('Sangiovese');
  });

  it('writes grapes + grapePrimary when grapes were empty', () => {
    const rec = silverRecord({ canonicalLabel: 'Sassicaia 2018', producer: 'Tenuta San Guido' });
    const after = applyGrapesToRecord(rec, ['Cabernet Sauvignon', 'Cabernet Franc']);
    expect(after.grapes).toEqual(['Cabernet Sauvignon', 'Cabernet Franc']);
    // resolveDominantGrape resolves single dominant grape using region heuristic
    // table; without a Bordeaux/Bolgheri match in searchBlob the fallback is
    // grapes[0].
    expect(after.grapePrimary).toBe('Cabernet Sauvignon');
  });

  it('no-ops on an empty grape list', () => {
    const rec = silverRecord();
    expect(applyGrapesToRecord(rec, [])).toBe(rec);
  });
});

// ---------------------------------------------------------------------------
// Cache JSONL format + round-trip
// ---------------------------------------------------------------------------

describe('cache JSONL', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('rejects malformed cache entries via Zod', () => {
    expect(() =>
      CacheEntrySchema.parse({
        externalId: '',
        wikidataQid: null,
        grapes: null,
        queriedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
    expect(() =>
      CacheEntrySchema.parse({
        externalId: 'vivino-1',
        wikidataQid: null,
        grapes: null,
        queriedAt: '2026-01-01T00:00:00Z',
        extra: 'nope',
      }),
    ).toThrow();
  });

  it('round-trips append + load and pins the JSONL line shape', async () => {
    const cachePath = path.join(dir, 'cache.jsonl');
    const entries: CacheEntry[] = [
      {
        externalId: 'vivino-1',
        wikidataQid: 'Q123',
        grapes: ['Cabernet Sauvignon'],
        queriedAt: '2026-05-24T00:00:00.000Z',
      },
      {
        externalId: 'vivino-2',
        wikidataQid: null,
        grapes: null,
        queriedAt: '2026-05-24T00:00:01.000Z',
      },
    ];
    for (const e of entries) await appendCacheEntry(cachePath, e);

    // Verify on-disk format is one compact JSON per line, newline-terminated.
    const raw = await fsp.readFile(cachePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual(entries[0]);
    expect(JSON.parse(lines[1]!)).toEqual(entries[1]);

    const loaded = await loadCache(cachePath);
    expect(loaded.size).toBe(2);
    expect(loaded.get('vivino-1')?.grapes).toEqual(['Cabernet Sauvignon']);
    expect(loaded.get('vivino-2')?.grapes).toBeNull();
  });

  it('loadCache returns empty map when the file does not exist', async () => {
    const loaded = await loadCache(path.join(dir, 'missing.jsonl'));
    expect(loaded.size).toBe(0);
  });

  it('loadCache drops corrupted lines but keeps valid ones', async () => {
    const cachePath = path.join(dir, 'mixed.jsonl');
    await fsp.writeFile(
      cachePath,
      [
        JSON.stringify({
          externalId: 'vivino-good',
          wikidataQid: 'Q1',
          grapes: ['Pinot Noir'],
          queriedAt: '2026-01-01T00:00:00Z',
        }),
        '{not-json',
        JSON.stringify({ schema_drift: true }),
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadCache(cachePath);
    expect(loaded.size).toBe(1);
    expect(loaded.get('vivino-good')?.grapes).toEqual(['Pinot Noir']);
  });
});

// ---------------------------------------------------------------------------
// runBackfill — end-to-end pipeline behaviour
// ---------------------------------------------------------------------------

describe('runBackfill end-to-end', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  async function writeSilver(records: readonly SilverRecordLike[]): Promise<string> {
    const p = path.join(dir, 'silver.ndjson');
    await fsp.writeFile(
      p,
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );
    return p;
  }

  it('backfills empty-grape records and passes through populated ones', async () => {
    const input = await writeSilver([
      silverRecord({
        externalId: 'vivino-empty',
        canonicalLabel: 'Château Margaux 2015',
        grapes: [],
      }),
      silverRecord({
        externalId: 'vivino-populated',
        canonicalLabel: 'Penfolds Grange 2017',
        producer: 'Penfolds',
        grapes: ['Shiraz'],
        grapePrimary: 'Shiraz',
      }),
    ]);
    const output = path.join(dir, 'out.ndjson');
    const cache = path.join(dir, 'cache.jsonl');

    const fetchFn = vi.fn<FetchLike>(async () =>
      makeJsonResponse(
        makeSparqlBody([
          {
            wineQid: 'Q123',
            wineLabel: 'Château Margaux',
            grapeLabel: 'Cabernet Sauvignon',
          },
          { wineQid: 'Q123', wineLabel: 'Château Margaux', grapeLabel: 'Merlot' },
        ]),
      ),
    );

    const summary = await runBackfill({
      inputPath: input,
      outputPath: output,
      cachePath: cache,
      fetchFn,
      sleepFn: async () => {},
      logger: () => {},
    });

    expect(summary.total).toBe(2);
    expect(summary.backfilled).toBe(1);
    expect(summary.skippedExisting).toBe(1);
    expect(summary.missed).toBe(0);
    // Only ONE SPARQL call — the populated record must not hit the network.
    expect(fetchFn).toHaveBeenCalledOnce();

    const outRaw = await fsp.readFile(output, 'utf8');
    const outLines = outRaw.split('\n').filter((l) => l.length > 0);
    const augmented = JSON.parse(outLines[0]!) as SilverRecordLike;
    const populated = JSON.parse(outLines[1]!) as SilverRecordLike;
    expect(augmented.grapes).toEqual(['Cabernet Sauvignon', 'Merlot']);
    expect(augmented.grapePrimary).toBe('Cabernet Sauvignon');
    expect(populated.grapes).toEqual(['Shiraz']); // preserved
    expect(populated.grapePrimary).toBe('Shiraz');
  });

  it('cache hit on second run avoids any SPARQL call', async () => {
    const input = await writeSilver([
      silverRecord({
        externalId: 'vivino-once',
        canonicalLabel: 'Château Margaux 2015',
        grapes: [],
      }),
    ]);
    const output1 = path.join(dir, 'out1.ndjson');
    const output2 = path.join(dir, 'out2.ndjson');
    const cache = path.join(dir, 'cache.jsonl');

    const fetchFn1 = vi.fn<FetchLike>(async () =>
      makeJsonResponse(
        makeSparqlBody([
          {
            wineQid: 'Q123',
            wineLabel: 'Château Margaux',
            grapeLabel: 'Cabernet Sauvignon',
          },
        ]),
      ),
    );
    await runBackfill({
      inputPath: input,
      outputPath: output1,
      cachePath: cache,
      fetchFn: fetchFn1,
      sleepFn: async () => {},
      logger: () => {},
    });
    expect(fetchFn1).toHaveBeenCalledOnce();

    const fetchFn2 = vi.fn<FetchLike>(async () => {
      throw new Error('fetch must NOT be called on cache-hit re-run');
    });
    const summary2 = await runBackfill({
      inputPath: input,
      outputPath: output2,
      cachePath: cache,
      fetchFn: fetchFn2,
      sleepFn: async () => {},
      logger: () => {},
    });
    expect(fetchFn2).not.toHaveBeenCalled();
    expect(summary2.skippedCached).toBe(1);
    expect(summary2.backfilled).toBe(1); // applied from cache
  });

  it('records misses in the cache so retries do not re-query', async () => {
    const input = await writeSilver([
      silverRecord({
        externalId: 'vivino-noisy',
        canonicalLabel: 'Unknown Obscure Wine 2010',
        producer: 'Unknown Estate',
        grapes: [],
      }),
    ]);
    const output1 = path.join(dir, 'out1.ndjson');
    const output2 = path.join(dir, 'out2.ndjson');
    const cache = path.join(dir, 'cache.jsonl');

    // Both phase-1 and phase-2 return empty.
    const fetchFn1 = vi.fn<FetchLike>(async () =>
      makeJsonResponse({ results: { bindings: [] } }),
    );
    const summary1 = await runBackfill({
      inputPath: input,
      outputPath: output1,
      cachePath: cache,
      fetchFn: fetchFn1,
      sleepFn: async () => {},
      logger: () => {},
    });
    expect(summary1.missed).toBe(1);
    expect(summary1.backfilled).toBe(0);

    // Re-run: cache should hold the miss decision.
    const fetchFn2 = vi.fn<FetchLike>(async () => {
      throw new Error('fetch must NOT be called on cache-hit re-run');
    });
    const summary2 = await runBackfill({
      inputPath: input,
      outputPath: output2,
      cachePath: cache,
      fetchFn: fetchFn2,
      sleepFn: async () => {},
      logger: () => {},
    });
    expect(fetchFn2).not.toHaveBeenCalled();
    expect(summary2.skippedCached).toBe(1);
    expect(summary2.missed).toBe(1);
  });

  it('throws on persistent transport failure (fail-loud)', async () => {
    const input = await writeSilver([
      silverRecord({
        externalId: 'vivino-down',
        canonicalLabel: 'Château Margaux 2015',
        grapes: [],
      }),
    ]);
    const output = path.join(dir, 'out.ndjson');
    const cache = path.join(dir, 'cache.jsonl');

    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response('boom', { status: 503 }),
    );

    await expect(
      runBackfill({
        inputPath: input,
        outputPath: output,
        cachePath: cache,
        fetchFn,
        sleepFn: async () => {},
        logger: () => {},
      }),
    ).rejects.toThrow(/SPARQL transport failure/);
  });

  it('does NOT overwrite existing varietal-parsed grapes even when SPARQL returns different grapes', async () => {
    // Regression for the no-overwrite invariant — distinct from the
    // applyGrapesToRecord unit test because we exercise the full pipeline.
    const input = await writeSilver([
      silverRecord({
        externalId: 'vivino-keep',
        canonicalLabel: 'Brunello di Montalcino 2015',
        producer: 'Biondi-Santi',
        grapes: ['Sangiovese'],
        grapePrimary: 'Sangiovese',
      }),
    ]);
    const output = path.join(dir, 'out.ndjson');
    const cache = path.join(dir, 'cache.jsonl');

    const fetchFn = vi.fn<FetchLike>(async () =>
      makeJsonResponse(
        makeSparqlBody([
          { wineQid: 'Q42', wineLabel: 'Wrong', grapeLabel: 'Cabernet Sauvignon' },
        ]),
      ),
    );
    const summary = await runBackfill({
      inputPath: input,
      outputPath: output,
      cachePath: cache,
      fetchFn,
      sleepFn: async () => {},
      logger: () => {},
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary.skippedExisting).toBe(1);
    expect(summary.backfilled).toBe(0);
    const outLines = (await fsp.readFile(output, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    const after = JSON.parse(outLines[0]!) as SilverRecordLike;
    expect(after.grapes).toEqual(['Sangiovese']);
    expect(after.grapePrimary).toBe('Sangiovese');
  });
});
