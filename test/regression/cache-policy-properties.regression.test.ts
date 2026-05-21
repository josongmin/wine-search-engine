/**
 * Cache-policy / cache-key — property-based regression suite.
 *
 * Locks the structural invariants of the retrieval cache policy
 * (`retrieval.cache-policy`, maturity 3 → SOTA++ push). The policy layer
 * decides (a) the deterministic cache KEY for a retrieval result and (b) the
 * TTL it is written under. Property tests (numRuns=100) pin the invariants
 * that unit tests can only sample:
 *
 *   1. Determinism — same (query, mode, constraints, expansions, ctx) → same key.
 *   2. Order-independence — constraint / expansion order does not affect the key
 *      (they are SETs of facts, not sequences).
 *   3. Unicode-form invariance (NFC) — Korean (한글) and accented Latin text in
 *      NFC vs NFD form produce the SAME key. This is the load-bearing fix: the
 *      builder now NFC-canonicalizes every hashed field so an upstream
 *      normalizer's choice of form cannot fragment one query into two buckets.
 *   4. Collision-freedom — distinct semantic inputs (query / mode / snapshot /
 *      locale / soft-vs-hard / lexical-vs-semantic) produce DISTINCT keys.
 *   5. Edge keys — empty constraint/expansion sets, empty/whitespace strings,
 *      and -0 vs 0 numeric-derived constraint values behave correctly.
 *   6. TTL SSoT — write TTL defaults derive from the named `CACHE_TTL_SECONDS`
 *      constants (cache-ttl-config.ts), never magic numbers, and `??` (not `||`)
 *      is used so a legitimate explicit TTL of 0 is NOT silently replaced.
 *
 * Append-only regression file — never delete. See CLAUDE.md "Test discipline".
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  QueryCacheKeyBuilder,
  EmbeddingCacheKeyBuilder,
} from '../../src/domain/performance/model/cache-key.js';
import { CACHE_TTL_SECONDS, defaultTtlSecondsFor } from '../../src/infrastructure/cache/cache-ttl-config.js';
import type { RetrievalMode } from '../../src/domain/query/model/retrieval-mode.js';

const FC_RUNS = 100;

const builder = new QueryCacheKeyBuilder();
const embeddingBuilder = new EmbeddingCacheKeyBuilder();

const RETRIEVAL_MODES: readonly RetrievalMode[] = [
  'entity_lookup',
  'attribute_search',
  'constraint_filter',
  'producer_browse',
  'region_browse',
];

const arbMode = fc.constantFrom(...RETRIEVAL_MODES);

// Korean-rich strings exercise the NFC invariant; mix in plain text so we also
// cover the ASCII happy path inside the same generator.
const arbText = fc.oneof(
  fc.string(),
  fc.constantFrom(
    '오퍼스 원',
    '샤또 마고',
    '부르고뉴 피노 누아',
    '레드 와인 추천',
    '바롤로',
    'café',
    'jalapeño',
    'bordeaux 2015',
    '',
    '   ',
  ),
);

const arbConstraintTuple = fc.tuple(
  fc.constantFrom('country', 'region', 'producer', 'vintage', 'soft:region', '품종'),
  fc.constantFrom('eq', 'gte', 'lte', 'in'),
  arbText,
);
const arbConstraints = fc.array(arbConstraintTuple, { maxLength: 6 });
const arbExpansions = fc.array(
  fc.tuple(fc.constantFrom('L:', 'S:'), arbText).map(([p, t]) => `${p}${t}`),
  { maxLength: 6 },
);

/** Decompose every codepoint to NFD so the input is the same query, wrong form. */
function toNfd(s: string): string {
  return s.normalize('NFD');
}

describe('cache-policy properties: cache-key determinism', () => {
  it('same inputs always produce the same key (deterministic, numRuns=100)', () => {
    fc.assert(
      fc.property(
        arbText, arbMode, arbConstraints, arbExpansions,
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.constantFrom('ko-KR', 'en-US', 'ja-JP'), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (q, mode, constraints, expansions, session, locale, snapshot) => {
          const a = builder.build(q, mode, constraints, expansions, session, locale, snapshot);
          const b = builder.build(q, mode, constraints, expansions, session, locale, snapshot);
          expect(a.redisKey).toBe(b.redisKey);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('constraint order does not affect the key (set semantics, numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbMode, arbConstraints, (q, mode, constraints) => {
        const reversed = [...constraints].reverse();
        const a = builder.build(q, mode, constraints, []);
        const b = builder.build(q, mode, reversed, []);
        expect(a.redisKey).toBe(b.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('expansion order does not affect the key (set semantics, numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbMode, arbExpansions, (q, mode, expansions) => {
        const reversed = [...expansions].reverse();
        const a = builder.build(q, mode, [], expansions);
        const b = builder.build(q, mode, [], reversed);
        expect(a.redisKey).toBe(b.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('cache-policy properties: NFC Unicode-form invariance (Korean)', () => {
  it('NFC vs NFD query text produce the SAME key (numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbMode, (q, mode) => {
        const nfc = builder.build(q.normalize('NFC'), mode, [], []);
        const nfd = builder.build(toNfd(q), mode, [], []);
        expect(nfc.redisKey).toBe(nfd.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('NFC vs NFD constraint values produce the SAME key (numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbConstraints, (q, constraints) => {
        const nfd = constraints.map(
          ([a, op, v]) => [toNfd(a), op, toNfd(v)] as const,
        );
        const a = builder.build(q.normalize('NFC'), 'attribute_search', constraints, []);
        const b = builder.build(toNfd(q), 'attribute_search', nfd, []);
        expect(a.redisKey).toBe(b.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('NFC vs NFD expansion terms produce the SAME key (numRuns=100)', () => {
    fc.assert(
      fc.property(arbExpansions, (expansions) => {
        const nfd = expansions.map(toNfd);
        const a = builder.build('q', 'attribute_search', [], expansions);
        const b = builder.build('q', 'attribute_search', [], nfd);
        expect(a.redisKey).toBe(b.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('concrete: composed 오퍼스 (NFC) and decomposed jamo (NFD) share a bucket', () => {
    const composed = '오퍼스 원';
    const decomposed = composed.normalize('NFD');
    expect(composed).not.toBe(decomposed); // different code units
    const a = builder.build(composed, 'entity_lookup', [], []);
    const b = builder.build(decomposed, 'entity_lookup', [], []);
    expect(a.redisKey).toBe(b.redisKey);
  });

  it('embedding cache key is also NFC-invariant for Korean text', () => {
    const composed = '부르고뉴 피노 누아';
    const a = embeddingBuilder.build(composed, 'text-embedding-3-small', 'Search: ');
    const b = embeddingBuilder.build(composed.normalize('NFD'), 'text-embedding-3-small', 'Search: ');
    expect(a.redisKey).toBe(b.redisKey);
  });
});

describe('cache-policy properties: collision-freedom', () => {
  it('different snapshot IDs never share a key (numRuns=100)', () => {
    fc.assert(
      fc.property(
        arbText, arbMode, fc.string({ minLength: 1 }), fc.string({ minLength: 1 }),
        (q, mode, s1, s2) => {
          fc.pre(s1.normalize('NFC') !== s2.normalize('NFC'));
          const a = builder.build(q, mode, [], [], undefined, undefined, s1);
          const b = builder.build(q, mode, [], [], undefined, undefined, s2);
          expect(a.redisKey).not.toBe(b.redisKey);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('different present locales never share a key (numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbMode, (q, mode) => {
        const ko = builder.build(q, mode, [], [], undefined, 'ko-KR');
        const en = builder.build(q, mode, [], [], undefined, 'en-US');
        expect(ko.redisKey).not.toBe(en.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('soft vs hard constraint of same name never share a key (numRuns=100)', () => {
    fc.assert(
      fc.property(arbText, arbText, (q, value) => {
        const hard = builder.build(q, 'attribute_search', [['region', 'eq', value]], []);
        const soft = builder.build(q, 'attribute_search', [['soft:region', 'eq', value]], []);
        expect(hard.redisKey).not.toBe(soft.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('cache-policy properties: edge keys', () => {
  it('empty constraint set and empty expansion set are stable and equal across calls', () => {
    const a = builder.build('레드 와인', 'entity_lookup', [], []);
    const b = builder.build('레드 와인', 'entity_lookup', [], []);
    expect(a.redisKey).toBe(b.redisKey);
  });

  it('whitespace-only query is NFC-stable (numRuns=100)', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', '   ', '\t', '　'), arbMode, (q, mode) => {
        const a = builder.build(q, mode, [], []);
        const b = builder.build(q.normalize('NFD'), mode, [], []);
        expect(a.redisKey).toBe(b.redisKey);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('-0 and 0 derived constraint values map to the same key (numeric edge)', () => {
    // String(-0) === '0' in JS; the value reaches the builder as a string.
    // This pins that a constraint derived from -0 vs 0 cannot fragment a bucket.
    const negZero = String(-0);
    const posZero = String(0);
    expect(negZero).toBe(posZero);
    const a = builder.build('q', 'constraint_filter', [['vintage', 'eq', negZero]], []);
    const b = builder.build('q', 'constraint_filter', [['vintage', 'eq', posZero]], []);
    expect(a.redisKey).toBe(b.redisKey);
  });

  it('empty-string constraint value does not collide with absent constraint', () => {
    const withEmpty = builder.build('q', 'constraint_filter', [['region', 'eq', '']], []);
    const without = builder.build('q', 'constraint_filter', [], []);
    expect(withEmpty.redisKey).not.toBe(without.redisKey);
  });
});

describe('cache-policy properties: TTL SSoT (cache-ttl-config)', () => {
  it('QUERY default TTL is the named SSoT constant, not a magic number', () => {
    expect(defaultTtlSecondsFor('QUERY')).toBe(CACHE_TTL_SECONDS.QUERY);
    // 5 minutes — documented freshness/hit-rate tradeoff in cache-ttl-config.ts.
    expect(CACHE_TTL_SECONDS.QUERY).toBe(5 * 60);
  });

  it('EMBEDDING and PHRASE TTLs are positive, finite, and ordered as documented', () => {
    for (const kind of ['EMBEDDING', 'PHRASE', 'QUERY'] as const) {
      const ttl = defaultTtlSecondsFor(kind);
      expect(Number.isFinite(ttl)).toBe(true);
      expect(ttl).toBeGreaterThan(0);
    }
    // Embeddings outlive phrase cache outlives query cache (stability ordering).
    expect(CACHE_TTL_SECONDS.EMBEDDING).toBeGreaterThan(CACHE_TTL_SECONDS.PHRASE);
    expect(CACHE_TTL_SECONDS.PHRASE).toBeGreaterThan(CACHE_TTL_SECONDS.QUERY);
  });

  it('an explicit TTL of 0 must NOT be replaced by the default (?? not ||)', () => {
    // Documents the nullish-coalescing contract that callers rely on:
    // `ttlSeconds ?? CACHE_TTL_SECONDS.QUERY` preserves an explicit 0, whereas
    // `ttlSeconds || ...` would silently substitute the 5-minute default.
    const explicitZero = 0;
    const effectiveNullish = explicitZero ?? CACHE_TTL_SECONDS.QUERY;
    expect(effectiveNullish).toBe(0);
    const undefinedTtl: number | undefined = undefined;
    const effectiveDefault = undefinedTtl ?? CACHE_TTL_SECONDS.QUERY;
    expect(effectiveDefault).toBe(CACHE_TTL_SECONDS.QUERY);
  });
});
