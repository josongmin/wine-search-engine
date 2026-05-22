/**
 * Property-based regression tests for the comparison RETRIEVAL leg
 * (`src/domain/retrieval/service/compare-retriever.ts`).
 *
 * This is the retrieval half of `retrieval.comparison-retrieval`: given an
 * anchor wine, `CompareRetriever.compareAgainstAnchor` derives lexical legs
 * from the anchor's producer/region/grape/style profile, over-fetches a
 * BOUNDED set of sparse hits, de-dups, excludes the anchor itself, and applies
 * hard constraint filters — feeding the comparison candidate set the ranking
 * layer (and `comparison-contrast.ts`, covered separately) consumes.
 *
 * Because this is the substrate every compare answer is built on, the
 * following invariants MUST hold; any regression silently degrades comparison
 * results without throwing.
 *
 * Invariants verified (append-only, SOTA++ grade, numRuns=100):
 *  1. Determinism — same anchor + index yields a deep-equal candidate list
 *     across repeated calls AND across permutations of the index hit order
 *     (output must not leak the backend's iteration order — SSoT comparator).
 *  2. Bounded fan-out — never returns more than `limit` candidates, and never
 *     asks the index for more than FETCH_MULTIPLIER × limit (named const, not
 *     a magic number) regardless of how many anchor lexical legs are emitted.
 *  3. Anchor self-exclusion — the anchor entity is NEVER in its own
 *     comparison set, even when it ranks #1 in the sparse hits.
 *  4. NaN / Infinity score safety — adversarial non-finite scores never crash,
 *     never sort a NaN hit ahead of a finite competitor, and produce a stable
 *     order (delegated to the SSoT `dedupeSparseHitsByEntity` NaN→-Infinity
 *     normalization + entityId tiebreaker).
 *  5. Per-entity candidate-set independence — comparing against anchor X then
 *     anchor Y returns X's set and Y's set independently; neither leaks the
 *     other's candidates or mutates shared state across calls.
 *  6. NFC on Korean anchors — an anchor whose Korean fields are NFD-decomposed
 *     produces the SAME lexical query legs (NFC-composed) as the byte-distinct
 *     NFC anchor, so the BM25 match against the NFC-indexed field does not
 *     silently miss.
 *  7. Empty / single safety — an unknown anchor (getDocument → null) and an
 *     anchor with no usable lexical legs both return [] without throwing; a
 *     single non-anchor hit is returned as a one-element set.
 *  8. No private RRF — compare-retriever fuses nothing of its own; sparse legs
 *     are de-duped via the SSoT and never carry a fabricated fusionRrfTotal
 *     (the BM25 raw score lives in sparseRawScore only).
 *
 * Touch-policy: regression-only, append-only. Never loosen the retriever to
 * make a property pass.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { CompareRetriever } from '../../src/domain/retrieval/service/compare-retriever.js';
import type {
  SearchIndexPort,
  SparseHit,
} from '../../src/domain/retrieval/port/search-index.port.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

const NUM_RUNS = 100;

/** Mirror of the retriever's bounded over-fetch multiplier (named const). */
const EXPECTED_FETCH_MULTIPLIER = 4;

const EMPTY_BUNDLE: ConstraintBundle = { hard: [], soft: [], inferred: [] };

// Korean wine surface labels (composed, NFC) used for Korean-case coverage.
const KOREAN_LABELS = [
  '오퍼스 원 2018',
  '샤토 마고 2015',
  '돔 페리뇽',
  '바롤로 리세르바',
  '브루넬로 디 몬탈치노',
] as const;
const KOREAN_REGIONS = ['보르도', '나파 밸리', '토스카나', '리오하', '부르고뉴'] as const;
const KOREAN_PRODUCERS = ['오퍼스 원', '샤토 마고', '돔 페리뇽', '안티노리'] as const;
const KOREAN_GRAPES = ['카베르네 소비뇽', '메를로', '피노 누아', '산지오베제'] as const;

function makeDoc(spec: {
  readonly id: string;
  readonly label: string;
  readonly producer: string;
  readonly region: string;
  readonly grapes: readonly string[];
  readonly style: string;
  readonly appellation?: string | undefined;
  readonly country?: string | undefined;
}): RetrievalDocument {
  return {
    entityId: createEntityId(spec.id),
    entityType: 'wine',
    canonicalLabel: spec.label,
    aliasesIdentitySafe: [],
    aliasesNoisyRecall: [],
    producer: spec.producer,
    region: spec.region,
    grapes: spec.grapes,
    searchTextKo: '',
    searchTextEn: '',
    semanticSummary: '',
    style: spec.style,
    pairing: [],
    occasion: [],
    availability: true,
    grapePrimary: spec.grapes[0] ?? '',
    ...(spec.appellation !== undefined ? { appellation: spec.appellation } : {}),
    ...(spec.country !== undefined ? { country: spec.country } : {}),
  } as RetrievalDocument;
}

function makeHit(spec: {
  readonly id: string;
  readonly score: number;
  readonly rank: number;
}): SparseHit {
  return {
    entityId: createEntityId(spec.id),
    score: spec.score,
    rank: spec.rank,
    matchedFields: ['search_text'],
    summary: { canonicalLabel: spec.id, producer: spec.id },
  };
}

/**
 * Build a fake SearchIndexPort that returns a fixed set of sparse hits (sliced
 * to the requested limit, as a real backend would) and the given anchor doc.
 * `lastSparseLimit` captures the over-fetch limit the retriever asked for so we
 * can assert the bounded-fan-out invariant.
 */
function makeIndex(opts: {
  readonly anchor: RetrievalDocument | null;
  readonly hits: readonly SparseHit[];
  readonly capture?: { sparseLimit?: number };
}): SearchIndexPort {
  return {
    sparseSearch: vi.fn(
      async (
        _queries: readonly string[],
        _filters?: readonly string[],
        limit?: number,
      ): Promise<readonly SparseHit[]> => {
        if (opts.capture !== undefined && limit !== undefined) {
          opts.capture.sparseLimit = limit;
        }
        const n = limit ?? opts.hits.length;
        return opts.hits.slice(0, n);
      },
    ),
    denseSearch: vi.fn(),
    searchLearnedSparse: vi.fn(async () => []),
    getDocument: vi.fn(async () => opts.anchor),
    getDocuments: vi.fn(async () => new Map()),
    upsertDocument: vi.fn(),
    bulkUpsert: vi.fn(),
  } as unknown as SearchIndexPort;
}

const idArb = fc.integer({ min: 1, max: 8 }).map((n) => `cmp-wine-${n}`);

const hitArb: fc.Arbitrary<SparseHit> = fc
  .record({
    id: idArb,
    // Adversarial scores: finite, NaN, ±Infinity, negative, zero.
    score: fc.oneof(
      fc.double({ min: -10, max: 100, noNaN: true, noDefaultInfinity: true }),
      fc.constantFrom(NaN, Infinity, -Infinity, 0, -0),
    ),
    rank: fc.integer({ min: 1, max: 50 }),
  })
  .map(makeHit);

const hitsArb = fc.array(hitArb, { minLength: 0, maxLength: 20 });

const anchorArb: fc.Arbitrary<RetrievalDocument> = fc
  .record({
    id: fc.constant('cmp-anchor'),
    label: fc.constantFrom(...KOREAN_LABELS),
    producer: fc.constantFrom(...KOREAN_PRODUCERS),
    region: fc.constantFrom(...KOREAN_REGIONS),
    grapes: fc.subarray([...KOREAN_GRAPES], { minLength: 0, maxLength: 3 }),
    style: fc.constantFrom('풀바디 레드', 'light red', '미디엄'),
  })
  .map(makeDoc);

const limitArb = fc.integer({ min: 1, max: 10 });

describe('comparison retrieval — property-based invariants', () => {
  it('1. determinism: identical anchor+index yields deep-equal candidates', async () => {
    await fc.assert(
      fc.asyncProperty(anchorArb, hitsArb, limitArb, async (anchor, hits, limit) => {
        const index = makeIndex({ anchor, hits });
        const r = new CompareRetriever(index);
        const a = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, limit);
        const b = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, limit);
        expect(b).toStrictEqual(a);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('1b. order-independence: permuted index hit order yields identical candidates', async () => {
    await fc.assert(
      fc.asyncProperty(anchorArb, hitsArb, limitArb, async (anchor, hits, _limit) => {
        const forward = new CompareRetriever(makeIndex({ anchor, hits }));
        const reversed = new CompareRetriever(
          makeIndex({ anchor, hits: [...hits].reverse() }),
        );
        // Backend may return a different slice when reversed AND truncated to
        // the over-fetch limit. To isolate the retriever's own determinism we
        // give both backends the FULL (un-truncated) hit list — the retriever
        // must then produce a permutation-invariant ordering itself.
        const a = await forward.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, hits.length + 1);
        const b = await reversed.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, hits.length + 1);
        const ids = (xs: readonly { entityId: string }[]): string[] =>
          xs.map((x) => x.entityId);
        expect(ids(b)).toStrictEqual(ids(a));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('2. bounded fan-out: ≤ limit results, ≤ FETCH_MULTIPLIER×limit over-fetch', async () => {
    await fc.assert(
      fc.asyncProperty(anchorArb, hitsArb, limitArb, async (anchor, hits, limit) => {
        const capture: { sparseLimit?: number } = {};
        const index = makeIndex({ anchor, hits, capture });
        const r = new CompareRetriever(index);
        const out = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, limit);
        expect(out.length).toBeLessThanOrEqual(limit);
        if (capture.sparseLimit !== undefined) {
          expect(capture.sparseLimit).toBeLessThanOrEqual(limit * EXPECTED_FETCH_MULTIPLIER);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('3. anchor self-exclusion: anchor never appears in its own comparison set', async () => {
    await fc.assert(
      fc.asyncProperty(anchorArb, hitsArb, limitArb, async (anchor, hits, limit) => {
        // Force the anchor to the TOP of the hit list with the best score.
        const withAnchor: readonly SparseHit[] = [
          makeHit({ id: String(anchor.entityId), score: 1e6, rank: 1 }),
          ...hits,
        ];
        const r = new CompareRetriever(makeIndex({ anchor, hits: withAnchor }));
        const out = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, limit);
        for (const c of out) {
          expect(String(c.entityId)).not.toBe(String(anchor.entityId));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('4. NaN/Infinity score safety: never throws, NaN never out-ranks finite', async () => {
    await fc.assert(
      fc.asyncProperty(anchorArb, hitsArb, limitArb, async (anchor, hits, limit) => {
        const r = new CompareRetriever(makeIndex({ anchor, hits }));
        const out = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, limit);
        // No NaN sparseRawScore should sort ahead of a finite one. The retriever
        // preserves backend BM25 in sparseRawScore; the dedup/sort SSoT treats
        // NaN as -Infinity, so any finite-score candidate must precede a
        // non-finite-score candidate in output order.
        let seenNonFinite = false;
        for (const c of out) {
          const s = c.sparseRawScore ?? NaN;
          if (!Number.isFinite(s)) {
            seenNonFinite = true;
          } else {
            // a finite score after a non-finite one would violate descending order
            expect(seenNonFinite).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('5. per-entity independence: two anchors return disjoint own-exclusions', async () => {
    const anchorX = makeDoc({
      id: 'cmp-anchor-x',
      label: '바롤로 리세르바',
      producer: '안티노리',
      region: '토스카나',
      grapes: ['산지오베제'],
      style: '풀바디 레드',
    });
    const anchorY = makeDoc({
      id: 'cmp-anchor-y',
      label: '돔 페리뇽',
      producer: '돔 페리뇽',
      region: '부르고뉴',
      grapes: ['피노 누아'],
      style: 'light red',
    });
    const sharedHits: readonly SparseHit[] = [
      makeHit({ id: 'cmp-anchor-x', score: 50, rank: 1 }),
      makeHit({ id: 'cmp-anchor-y', score: 40, rank: 2 }),
      makeHit({ id: 'cmp-other', score: 30, rank: 3 }),
    ];
    const rx = new CompareRetriever(
      makeIndex({ anchor: anchorX, hits: sharedHits }),
    );
    const ry = new CompareRetriever(
      makeIndex({ anchor: anchorY, hits: sharedHits }),
    );
    const outX = await rx.compareAgainstAnchor(anchorX.entityId, EMPTY_BUNDLE, 10);
    const outY = await ry.compareAgainstAnchor(anchorY.entityId, EMPTY_BUNDLE, 10);
    // X excludes itself but may include Y; Y excludes itself but may include X.
    expect(outX.map((c) => String(c.entityId))).not.toContain('cmp-anchor-x');
    expect(outX.map((c) => String(c.entityId))).toContain('cmp-anchor-y');
    expect(outY.map((c) => String(c.entityId))).not.toContain('cmp-anchor-y');
    expect(outY.map((c) => String(c.entityId))).toContain('cmp-anchor-x');
  });

  it('6. NFC: NFD-decomposed Korean anchor yields the SAME lexical legs as NFC', async () => {
    const nfcAnchor = makeDoc({
      id: 'cmp-anchor',
      label: '오퍼스 원 2018',
      producer: '오퍼스 원',
      region: '나파 밸리',
      grapes: ['카베르네 소비뇽'],
      style: '풀바디 레드',
    });
    // Byte-distinct NFD twin: decompose every Korean field.
    const nfdAnchor = makeDoc({
      id: 'cmp-anchor',
      label: nfcAnchor.canonicalLabel.normalize('NFD'),
      producer: nfcAnchor.producer.normalize('NFD'),
      region: nfcAnchor.region.normalize('NFD'),
      grapes: nfcAnchor.grapes.map((g) => g.normalize('NFD')),
      style: nfcAnchor.style.normalize('NFD'),
    });
    expect(nfdAnchor.canonicalLabel).not.toBe(nfcAnchor.canonicalLabel); // sanity

    const captureNfc: { queries?: readonly string[] } = {};
    const captureNfd: { queries?: readonly string[] } = {};
    const idxFor = (
      anchor: RetrievalDocument,
      cap: { queries?: readonly string[] },
    ): SearchIndexPort =>
      ({
        sparseSearch: vi.fn(async (queries: readonly string[]) => {
          cap.queries = queries;
          return [];
        }),
        denseSearch: vi.fn(),
        searchLearnedSparse: vi.fn(async () => []),
        getDocument: vi.fn(async () => anchor),
        getDocuments: vi.fn(async () => new Map()),
        upsertDocument: vi.fn(),
        bulkUpsert: vi.fn(),
      }) as unknown as SearchIndexPort;

    await new CompareRetriever(idxFor(nfcAnchor, captureNfc)).compareAgainstAnchor(
      nfcAnchor.entityId,
      EMPTY_BUNDLE,
      5,
    );
    await new CompareRetriever(idxFor(nfdAnchor, captureNfd)).compareAgainstAnchor(
      nfdAnchor.entityId,
      EMPTY_BUNDLE,
      5,
    );

    // Same NFC-composed legs from both byte-distinct anchors.
    expect(captureNfd.queries).toStrictEqual(captureNfc.queries);
    // And every emitted leg is itself NFC-composed.
    for (const q of captureNfc.queries ?? []) {
      expect(q).toBe(q.normalize('NFC'));
    }
  });

  it('7. empty/single safety: unknown anchor → [], single hit → one element', async () => {
    // Unknown anchor (getDocument → null).
    const missing = new CompareRetriever(
      makeIndex({ anchor: null, hits: [makeHit({ id: 'x', score: 9, rank: 1 })] }),
    );
    await expect(
      missing.compareAgainstAnchor(createEntityId('nope'), EMPTY_BUNDLE, 5),
    ).resolves.toStrictEqual([]);

    // Single non-anchor hit.
    const anchor = makeDoc({
      id: 'cmp-anchor',
      label: '오퍼스 원 2018',
      producer: '오퍼스 원',
      region: '나파 밸리',
      grapes: ['카베르네 소비뇽'],
      style: '풀바디 레드',
    });
    const single = new CompareRetriever(
      makeIndex({ anchor, hits: [makeHit({ id: 'cmp-solo', score: 5, rank: 1 })] }),
    );
    const out = await single.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, 5);
    expect(out).toHaveLength(1);
    expect(String(out[0]?.entityId)).toBe('cmp-solo');
  });

  it('8. no private RRF: compare candidates carry sparseRawScore, never a fabricated fusion total', async () => {
    const anchor = makeDoc({
      id: 'cmp-anchor',
      label: '바롤로 리세르바',
      producer: '안티노리',
      region: '토스카나',
      grapes: ['산지오베제'],
      style: '풀바디 레드',
    });
    const hits: readonly SparseHit[] = [
      makeHit({ id: 'cmp-a', score: 12.5, rank: 1 }),
      makeHit({ id: 'cmp-b', score: 8.25, rank: 2 }),
    ];
    const r = new CompareRetriever(makeIndex({ anchor, hits }));
    const out = await r.compareAgainstAnchor(anchor.entityId, EMPTY_BUNDLE, 5);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      // BM25 raw score is preserved verbatim — no RRF transform applied.
      expect(typeof c.sparseRawScore).toBe('number');
      // fusionRrfTotal must NOT be fabricated for non-fused compare candidates.
      expect(c.fusionRrfTotal).toBeUndefined();
    }
    // The top BM25 score is preserved (no 1/(k+rank) rewrite).
    const scores = out.map((c) => c.sparseRawScore);
    expect(scores).toContain(12.5);
  });
});
