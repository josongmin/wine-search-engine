/**
 * Property-based regression tests for {@link CachedAliasMatcher}.
 *
 * Wave 4 locked the cache invariants by example (LRU eviction, stats, Korean
 * surface provenance, NFC/NFD separation) in
 * `alias-matcher-priority-cache.regression.test.ts`. This suite deepens that
 * coverage to SOTA++ grade by re-deriving the same invariants over arbitrary
 * input distributions with fast-check (numRuns: 100). Where the example suite
 * pins one hand-built sequence, the properties below force the implementation
 * to hold across thousands of randomized operation orders and key sets.
 *
 * The cache is a TRANSPARENT memoizer — match priority is owned by the inner
 * matcher; the cache MUST preserve inner ordering byte-identically and MUST NOT
 * re-sort. The "match priority" property therefore asserts that exact-ranked
 * results returned first by the inner matcher are still returned first after the
 * cache layer, over arbitrary candidate sets.
 *
 * Invariants verified (append-only):
 *  1. Match-priority preservation — for any candidate set ordered
 *     exact > fuzzy > metaphone by the inner matcher, the cached result
 *     preserves that order verbatim on both miss and hit; exact always first.
 *  2. Cache determinism — a 2nd call for the same query is a hit that returns a
 *     result reference-identical to the 1st, with no extra inner call.
 *  3. LRU eviction bound — after an arbitrary stream of distinct keys exceeding
 *     `maxEntries`, cache size never exceeds the cap.
 *  4. LRU recency — a key re-touched after insertion survives eviction over an
 *     older untouched key.
 *  5. Stats accuracy — after an arbitrary op sequence, getStats()
 *     {hits, misses, evictions} matches an independently-computed oracle.
 *  6. Korean alias — a Hangul surface resolves with stable provenance and is
 *     NFC-stable (same key on repeat → hit).
 *  7. Empty / whitespace query — returns [] with no inner call and no throw.
 *
 * Bumps nlu.alias-matcher maturity 4 → 5.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CachedAliasMatcher } from '../../src/infrastructure/adapter/cached-alias-matcher.js';
import type {
  AliasMatchResult,
  AliasMatcher,
} from '../../src/domain/query/service/anchor-extractor.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

const FC_RUNS = 100;

// ── In-memory inner matcher fixture (counts calls; SSoT for ordering) ────────

class CountingAliasMatcher implements AliasMatcher {
  findMatchesCalls = 0;
  readonly seenQueries: string[] = [];

  constructor(private readonly table: ReadonlyMap<string, readonly AliasMatchResult[]>) {}

  async findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    this.findMatchesCalls += 1;
    this.seenQueries.push(normalizedQuery);
    return this.table.get(normalizedQuery) ?? [];
  }
}

function mkResult(
  entityId: string,
  matchConfidence: number,
  lookupStrategy: string,
): AliasMatchResult {
  return {
    surfaceForm: entityId,
    normalizedForm: entityId,
    entityIds: [entityId as CanonicalEntityId],
    matchConfidence,
    lookupStrategy,
  };
}

// Strategy priority tiers, highest → lowest. Mirrors the inner matcher's SSoT
// ordering: exact beats fuzzy beats metaphone.
const STRATEGY_TIERS = ['exact', 'fuzzy', 'metaphone'] as const;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CachedAliasMatcher properties (regression)', () => {
  // ── Property 1: match-priority preservation ──────────────────────────────
  it('preserves inner exact > fuzzy > metaphone ordering on miss and hit', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A candidate set that is already priority-ordered by the inner matcher:
        // one entity per tier present, in tier order. Confidences strictly
        // descend to mirror real priority.
        fc.uniqueArray(fc.integer({ min: 0, max: STRATEGY_TIERS.length - 1 }), {
          minLength: 1,
          maxLength: STRATEGY_TIERS.length,
        }),
        async (tierIndexes) => {
          const orderedTiers = [...tierIndexes].sort((a, b) => a - b);
          const candidates: AliasMatchResult[] = orderedTiers.map((tierIdx, i) =>
            mkResult(`e-${tierIdx}`, 1 - i * 0.1, STRATEGY_TIERS[tierIdx] ?? 'exact'),
          );
          const inner = new CountingAliasMatcher(
            new Map([['q', candidates]]),
          );
          const cache = new CachedAliasMatcher(inner);

          const onMiss = await cache.findMatches('q');
          const onHit = await cache.findMatches('q');

          // Order preserved verbatim across the cache layer (no re-sort).
          expect(onMiss.map((r) => r.lookupStrategy)).toStrictEqual(
            candidates.map((r) => r.lookupStrategy),
          );
          expect(onHit).toStrictEqual(onMiss);

          // Exact (if present) is always ranked first; tier indexes never decrease.
          const tierRanks = onMiss.map((r) => STRATEGY_TIERS.indexOf(r.lookupStrategy as never));
          for (let i = 1; i < tierRanks.length; i += 1) {
            expect(tierRanks[i]).toBeGreaterThanOrEqual(tierRanks[i - 1] as number);
          }
          if (orderedTiers.includes(0)) {
            expect(onMiss[0]?.lookupStrategy).toBe('exact');
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 2: cache determinism ────────────────────────────────────────
  it('2nd call for the same query is a hit returning the identical result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
        async (rawQuery) => {
          const result = [mkResult('e-x', 0.9, 'exact')];
          const inner = new CountingAliasMatcher(new Map([[rawQuery.trim(), result]]));
          const cache = new CachedAliasMatcher(inner);

          const first = await cache.findMatches(rawQuery);
          const second = await cache.findMatches(rawQuery);

          expect(second).toBe(first); // reference-identical (cached, not recomputed)
          expect(inner.findMatchesCalls).toBe(1);
          const stats = cache.getStats();
          expect(stats.hits).toBe(1);
          expect(stats.misses).toBe(1);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 3: LRU eviction bound ───────────────────────────────────────
  it('cache size never exceeds maxEntries under an arbitrary key stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 60 }),
        async (cap, keyNums) => {
          // Inner returns a non-empty result for every key so all are cached.
          const wrapped: AliasMatcher = {
            async findMatches(q) {
              return [mkResult(`e-${q}`, 0.5, 'exact')];
            },
          };
          const cache = new CachedAliasMatcher(wrapped, { maxEntries: cap });

          for (const n of keyNums) {
            await cache.findMatches(`k-${n}`);
            expect(cache.getStats().size).toBeLessThanOrEqual(cap);
          }
          expect(cache.getStats().size).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 4: LRU recency ──────────────────────────────────────────────
  it('a re-touched key survives eviction over an older untouched key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        async (cap) => {
          const wrapped: AliasMatcher = {
            async findMatches(q) {
              return [mkResult(`e-${q}`, 0.5, 'exact')];
            },
          };
          const cache = new CachedAliasMatcher(wrapped, { maxEntries: cap });

          // Fill exactly to capacity with keys 0..cap-1.
          for (let i = 0; i < cap; i += 1) {
            await cache.findMatches(`k-${i}`);
          }
          // Re-touch the oldest key (k-0) → becomes most-recently-used.
          await cache.findMatches('k-0');
          // Insert one new key → forces exactly one eviction. The victim must be
          // k-1 (now oldest), NOT the freshly-touched k-0.
          await cache.findMatches('k-new');

          // k-0 is still resident → a hit, no new inner call beyond the touch.
          const stats0 = cache.getStats();
          await cache.findMatches('k-0');
          expect(cache.getStats().hits).toBe(stats0.hits + 1);

          // k-1 was evicted → a miss.
          const stats1 = cache.getStats();
          await cache.findMatches('k-1');
          expect(cache.getStats().misses).toBe(stats1.misses + 1);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 5: stats accuracy vs independent oracle ─────────────────────
  it('getStats() {hits, misses, evictions} match an independent oracle', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 0, maxLength: 40 }),
        async (cap, ops) => {
          const wrapped: AliasMatcher = {
            async findMatches(q) {
              return [mkResult(`e-${q}`, 0.5, 'exact')];
            },
          };
          const cache = new CachedAliasMatcher(wrapped, { maxEntries: cap });

          // Oracle: simulate an LRU cache (insertion-order Map semantics) and
          // count hits/misses/evictions exactly as the implementation should.
          const oracle = new Map<string, true>();
          let expectHits = 0;
          let expectMisses = 0;
          let expectEvictions = 0;

          for (const n of ops) {
            const key = `k-${n}`;
            // findMatches is sequential (awaited) so single-flight never triggers
            // a pending short-circuit here.
            if (oracle.has(key)) {
              expectHits += 1;
              oracle.delete(key);
              oracle.set(key, true); // touch → most recently used
            } else {
              expectMisses += 1;
              oracle.set(key, true);
              if (oracle.size > cap) {
                const oldest = oracle.keys().next().value as string;
                oracle.delete(oldest);
                expectEvictions += 1;
              }
            }
            await cache.findMatches(key);
          }

          const stats = cache.getStats();
          expect(stats.hits).toBe(expectHits);
          expect(stats.misses).toBe(expectMisses);
          expect(stats.evictions).toBe(expectEvictions);
          expect(stats.size).toBe(oracle.size);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 6: Korean alias — stable provenance, NFC-stable ─────────────
  it('Korean surface resolves with stable provenance and is NFC-stable', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Korean Hangul syllable block U+AC00..U+D7A3, NFC-normalized keys.
        fc
          .array(fc.integer({ min: 0xac00, max: 0xd7a3 }), { minLength: 1, maxLength: 6 })
          .map((codes) => String.fromCodePoint(...codes).normalize('NFC')),
        async (koreanKey) => {
          const result = [mkResult('wine-opus-one', 0.95, 'exact')];
          const inner = new CountingAliasMatcher(new Map([[koreanKey, result]]));
          const cache = new CachedAliasMatcher(inner);

          const first = await cache.findMatches(koreanKey);
          // Re-query with an explicitly NFC-normalized form → same key → hit.
          const second = await cache.findMatches(koreanKey.normalize('NFC'));

          expect(first).toHaveLength(1);
          expect(first[0]?.entityIds).toStrictEqual(['wine-opus-one']);
          expect(first[0]?.lookupStrategy).toBe('exact');
          expect(second).toBe(first); // NFC-stable → cache hit, identical ref
          expect(inner.findMatchesCalls).toBe(1);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 7: empty / whitespace query → no match, no throw ────────────
  it('empty or whitespace-only query returns [] without calling inner', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Strings composed only of ASCII/Unicode whitespace (incl. empty).
        fc
          .array(fc.constantFrom(' ', '\t', '\n', '\r', ' '), { minLength: 0, maxLength: 8 })
          .map((parts) => parts.join('')),
        async (blankQuery) => {
          const inner = new CountingAliasMatcher(new Map());
          const cache = new CachedAliasMatcher(inner);

          const result = await cache.findMatches(blankQuery);

          expect(result).toStrictEqual([]);
          expect(inner.findMatchesCalls).toBe(0);
          const stats = cache.getStats();
          expect(stats.hits).toBe(0);
          expect(stats.misses).toBe(0);
          expect(stats.size).toBe(0);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
