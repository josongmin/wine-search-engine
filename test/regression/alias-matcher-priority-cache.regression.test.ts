/**
 * Regression: CachedAliasMatcher — strategy priority preservation, deterministic
 * ordering, LRU eviction, and cache statistics.
 *
 * The maturity-3 audit flagged three gaps for nlu.alias-matcher:
 *   1. Cache had no observable eviction counter — operators couldn't tell whether
 *      the LRU cap was being exercised in production.
 *   2. No explicit `clear()` API — tests and warm-restart paths had to recreate
 *      the matcher to drop entries.
 *   3. Strategy ordering was assumed but not locked in by a regression suite —
 *      a future refactor could silently flip exact-vs-fuzzy precedence.
 *
 * This suite locks in:
 *   - CachedAliasMatcher preserves inner-matcher ordering verbatim (no
 *     re-sorting). The inner matcher is responsible for strategy priority:
 *     exact > alias > metaphone > token-overlap. The cache MUST be a transparent
 *     memoizer.
 *   - Korean alias surfaces (오푸스 원) resolve with `lookupStrategy` provenance
 *     intact across cache hits.
 *   - Cache hit/miss counting: a repeated query increments hits, not misses.
 *   - LRU eviction: filling beyond `maxEntries` evicts the oldest untouched key.
 *   - Deterministic ordering: identical inner results for the same query across
 *     5 calls produce byte-identical output.
 *   - Empty / whitespace / garbage queries do not pollute the cache.
 *   - Korean + English mixed surfaces are independently cached (separate keys).
 *   - NFC vs NFD Unicode forms collapse to the same canonical resolution when
 *     the inner matcher treats them as equivalent.
 *   - `clear()` resets `{hits, misses, evictions}` counters and entries.
 *   - `getStats()` exposes `{hits, misses, evictions, size}`.
 *
 * Bumps nlu.alias-matcher maturity 3 → 4.
 */

import { describe, expect, it } from 'vitest';
import { CachedAliasMatcher } from '../../src/infrastructure/adapter/cached-alias-matcher.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../src/domain/query/service/anchor-extractor.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

// ── In-memory inner matcher fixture ─────────────────────────────────────────

interface InnerMatcherCallLog {
  readonly findMatchesCalls: number;
  readonly findMatchesBatchCalls: number;
  readonly seenQueries: readonly string[];
}

class FixtureAliasMatcher implements AliasMatcher {
  private findMatchesCalls = 0;
  private findMatchesBatchCalls = 0;
  private readonly seenQueries: string[] = [];

  constructor(private readonly table: ReadonlyMap<string, readonly AliasMatchResult[]>) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    this.findMatchesCalls += 1;
    this.seenQueries.push(normalizedQuery);
    return this.table.get(normalizedQuery) ?? [];
  }

  async findMatchesBatch(
    normalizedQueries: readonly string[],
  ): Promise<ReadonlyMap<string, readonly AliasMatchResult[]>> {
    this.findMatchesBatchCalls += 1;
    const out = new Map<string, readonly AliasMatchResult[]>();
    for (const q of normalizedQueries) {
      this.seenQueries.push(q);
      out.set(q, this.table.get(q) ?? []);
    }
    return out;
  }

  getCallLog(): InnerMatcherCallLog {
    return {
      findMatchesCalls: this.findMatchesCalls,
      findMatchesBatchCalls: this.findMatchesBatchCalls,
      seenQueries: [...this.seenQueries],
    };
  }
}

function mkResult(
  surfaceForm: string,
  normalizedForm: string,
  entityId: string,
  matchConfidence: number,
  lookupStrategy: string,
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm,
    entityIds: [entityId as CanonicalEntityId],
    matchConfidence,
    lookupStrategy,
  };
}

// Priority-ordered fixture: exact > alias > metaphone > token_overlap. The
// inner matcher is the SSoT for ordering; the cache must preserve it.
const PRIORITY_ORDERED_OPUS: readonly AliasMatchResult[] = [
  mkResult('Opus One', 'opus one', 'wine-opus-one', 1.0, 'exact'),
  mkResult('Opus 1', 'opus 1', 'wine-opus-one', 0.93, 'compact_exact'),
  mkResult('Opuss One', 'opuss one', 'wine-opus-one', 0.88, 'phonetic_exact'),
  mkResult('Opus Won', 'opus won', 'wine-opus-one', 0.7, 'transliterated_fuzzy'),
];

// Korean alias resolution: 오푸스 원 → canonical entity, with provenance.
const KOREAN_OPUS_RESULTS: readonly AliasMatchResult[] = [
  mkResult('오푸스 원', '오푸스 원', 'wine-opus-one', 0.95, 'exact'),
];

// Mixed Korean + English: two alias hits from one query.
const MIXED_QUERY_RESULTS: readonly AliasMatchResult[] = [
  mkResult('Opus One', 'opus one', 'wine-opus-one', 1.0, 'exact'),
  mkResult('같은', '같은', 'marker-similarity', 0.6, 'token_overlap'),
];

// NFC vs NFD: 'é' as single char (NFC) vs 'e' + combining acute (NFD).
const NFC_QUERY = 'château margaux'.normalize('NFC');
const NFD_QUERY = 'château margaux'.normalize('NFD');
const CHATEAU_RESULTS: readonly AliasMatchResult[] = [
  mkResult('Château Margaux', 'chateau margaux', 'wine-margaux', 1.0, 'exact'),
];

// Tie-breaker: two entities at the same confidence — order must be stable
// across the cache layer (cache must not re-sort; inner controls the order).
const TIE_BREAK_RESULTS: readonly AliasMatchResult[] = [
  mkResult('Mont', 'mont', 'wine-a-mont', 0.9, 'exact'),
  mkResult('Mont', 'mont', 'wine-b-mont', 0.9, 'exact'),
];

function buildFixture(): FixtureAliasMatcher {
  return new FixtureAliasMatcher(
    new Map<string, readonly AliasMatchResult[]>([
      ['opus one', PRIORITY_ORDERED_OPUS],
      ['오푸스 원', KOREAN_OPUS_RESULTS],
      ['opus one 같은', MIXED_QUERY_RESULTS],
      [NFC_QUERY, CHATEAU_RESULTS],
      [NFD_QUERY, CHATEAU_RESULTS],
      ['mont', TIE_BREAK_RESULTS],
    ]),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CachedAliasMatcher priority & cache (regression)', () => {
  // ── Strategy priority preservation ───────────────────────────────────────

  it('preserves inner-matcher strategy ordering: exact > compact > phonetic > fuzzy', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const results = await cache.findMatches('opus one');

    expect(results.map((r) => r.lookupStrategy)).toStrictEqual([
      'exact',
      'compact_exact',
      'phonetic_exact',
      'transliterated_fuzzy',
    ]);
    // Confidence is monotonically non-increasing.
    const confidences = results.map((r) => r.matchConfidence);
    expect(confidences).toStrictEqual([...confidences].sort((a, b) => b - a));
  });

  it('preserves the same ordering on cache hit (no re-sort by cache)', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const first = await cache.findMatches('opus one');
    const second = await cache.findMatches('opus one');

    expect(second).toStrictEqual(first);
    expect(inner.getCallLog().findMatchesCalls).toBe(1);
  });

  // ── Korean alias resolution ──────────────────────────────────────────────

  it('resolves Korean alias 오푸스 원 with lookupStrategy provenance intact', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const results = await cache.findMatches('오푸스 원');

    expect(results).toHaveLength(1);
    expect(results[0]?.entityIds).toStrictEqual(['wine-opus-one']);
    expect(results[0]?.lookupStrategy).toBe('exact');
    expect(results[0]?.matchConfidence).toBeCloseTo(0.95);
  });

  // ── Cache hit / miss accounting ──────────────────────────────────────────

  it('counts a repeated query as a hit and not a duplicate inner call', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    await cache.findMatches('opus one');
    await cache.findMatches('opus one');
    await cache.findMatches('opus one');

    expect(inner.getCallLog().findMatchesCalls).toBe(1);
    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
  });

  it('counts independent queries as separate misses', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    await cache.findMatches('opus one');
    await cache.findMatches('오푸스 원');

    const stats = cache.getStats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
    expect(stats.size).toBe(2);
  });

  // ── LRU eviction ──────────────────────────────────────────────────────────

  it('evicts the oldest untouched entry when capacity is exceeded', async () => {
    const innerTable = new Map<string, readonly AliasMatchResult[]>([
      ['a', [mkResult('a', 'a', 'e-a', 1.0, 'exact')]],
      ['b', [mkResult('b', 'b', 'e-b', 1.0, 'exact')]],
      ['c', [mkResult('c', 'c', 'e-c', 1.0, 'exact')]],
      ['d', [mkResult('d', 'd', 'e-d', 1.0, 'exact')]],
    ]);
    const inner = new FixtureAliasMatcher(innerTable);
    const cache = new CachedAliasMatcher(inner, { maxEntries: 3 });

    await cache.findMatches('a');
    await cache.findMatches('b');
    await cache.findMatches('c');
    expect(cache.getStats().size).toBe(3);
    expect(cache.getStats().evictions).toBe(0);

    // 4th insertion evicts 'a' (oldest, untouched).
    await cache.findMatches('d');

    expect(cache.getStats().size).toBe(3);
    expect(cache.getStats().evictions).toBe(1);

    // 'a' is now a miss again → inner is called twice for 'a' in total.
    await cache.findMatches('a');
    expect(inner.getCallLog().findMatchesCalls).toBe(5);
  });

  it('LRU keeps a recently-touched entry alive past insertion order', async () => {
    const innerTable = new Map<string, readonly AliasMatchResult[]>([
      ['a', [mkResult('a', 'a', 'e-a', 1.0, 'exact')]],
      ['b', [mkResult('b', 'b', 'e-b', 1.0, 'exact')]],
      ['c', [mkResult('c', 'c', 'e-c', 1.0, 'exact')]],
      ['d', [mkResult('d', 'd', 'e-d', 1.0, 'exact')]],
    ]);
    const inner = new FixtureAliasMatcher(innerTable);
    const cache = new CachedAliasMatcher(inner, { maxEntries: 3 });

    await cache.findMatches('a');
    await cache.findMatches('b');
    await cache.findMatches('c');
    // Touch 'a' — it becomes most recently used; 'b' is now oldest.
    await cache.findMatches('a');
    await cache.findMatches('d');

    // 'b' should be evicted, not 'a'.
    expect(cache.getStats().evictions).toBe(1);
    const beforeFindCalls = inner.getCallLog().findMatchesCalls;
    await cache.findMatches('a'); // hit
    expect(inner.getCallLog().findMatchesCalls).toBe(beforeFindCalls);
    await cache.findMatches('b'); // miss — was evicted
    expect(inner.getCallLog().findMatchesCalls).toBe(beforeFindCalls + 1);
  });

  // ── Deterministic ordering across repeated calls ─────────────────────────

  it('produces byte-identical results across 5 repeated calls (determinism)', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const runs: readonly AliasMatchResult[][] = await Promise.all([
      cache.findMatches('opus one'),
      cache.findMatches('opus one'),
      cache.findMatches('opus one'),
      cache.findMatches('opus one'),
      cache.findMatches('opus one'),
    ]);

    const serialized = runs.map((r) => JSON.stringify(r));
    expect(new Set(serialized).size).toBe(1);
  });

  it('preserves stable order for tied confidences (no cache-side re-sort)', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const results = await cache.findMatches('mont');
    expect(results.map((r) => r.entityIds[0])).toStrictEqual([
      'wine-a-mont',
      'wine-b-mont',
    ]);
  });

  // ── Empty / no-match guards ──────────────────────────────────────────────

  it('returns [] for empty query and does not call inner', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    expect(await cache.findMatches('')).toStrictEqual([]);
    expect(await cache.findMatches('   ')).toStrictEqual([]);
    expect(inner.getCallLog().findMatchesCalls).toBe(0);
  });

  it('returns [] for garbage with no fixture entry', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    expect(await cache.findMatches('zzzzzzz-no-such-alias')).toStrictEqual([]);
  });

  // ── Korean + English mixed surfaces ──────────────────────────────────────

  it('caches Korean + English mixed query "opus one 같은" independently', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const results = await cache.findMatches('opus one 같은');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.entityIds[0])).toStrictEqual([
      'wine-opus-one',
      'marker-similarity',
    ]);

    // The mixed query is a different cache key from the English-only one.
    await cache.findMatches('opus one');
    expect(cache.getStats().size).toBe(2);
  });

  // ── NFC vs NFD ───────────────────────────────────────────────────────────

  it('treats NFC and NFD forms as separate cache keys (transparent memoizer)', async () => {
    // NFC and NFD have different code points; the cache MUST NOT silently
    // collapse them — that's the inner matcher's job. But each should still
    // resolve to the same canonical entity through the inner matcher.
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner);

    const nfc = await cache.findMatches(NFC_QUERY);
    const nfd = await cache.findMatches(NFD_QUERY);

    expect(nfc[0]?.entityIds).toStrictEqual(['wine-margaux']);
    expect(nfd[0]?.entityIds).toStrictEqual(['wine-margaux']);
    // If the two forms differ in code points, the cache should have two
    // entries; if they're already identical (rare), still resolves correctly.
    if (NFC_QUERY !== NFD_QUERY) {
      expect(cache.getStats().size).toBe(2);
    }
  });

  // ── clear() resets state ─────────────────────────────────────────────────

  it('clear() resets entries and stat counters', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner, { maxEntries: 2 });

    await cache.findMatches('opus one');
    await cache.findMatches('오푸스 원');
    await cache.findMatches('opus one 같은'); // forces eviction
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(1);
    expect(cache.getStats().size).toBeLessThanOrEqual(2);

    cache.clear();

    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.size).toBe(0);

    // After clear, a previously-cached query is a miss again.
    await cache.findMatches('opus one');
    expect(cache.getStats().misses).toBe(1);
  });

  // ── getStats() shape ─────────────────────────────────────────────────────

  it('getStats() returns {hits, misses, evictions, size} with exact counts', async () => {
    const inner = buildFixture();
    const cache = new CachedAliasMatcher(inner, { maxEntries: 2 });

    // Sequence: miss(a), miss(b), hit(a), miss(c)=evict b, hit(a)
    await cache.findMatches('opus one');         // miss → size 1
    await cache.findMatches('오푸스 원');           // miss → size 2
    await cache.findMatches('opus one');         // hit
    await cache.findMatches('opus one 같은');     // miss → evict 오푸스 원, size 2
    await cache.findMatches('opus one');         // hit

    const stats = cache.getStats();
    expect(stats.misses).toBe(3);
    expect(stats.hits).toBe(2);
    expect(stats.evictions).toBe(1);
    expect(stats.size).toBe(2);
  });
});
