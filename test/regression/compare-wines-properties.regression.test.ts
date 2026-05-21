/**
 * Property-based regression tests for the compare_wines contrast synthesis layer
 * (`src/domain/response/service/comparison-contrast.ts`).
 *
 * `compare_wines` was previously "단순 2x search" — two independent retrieval
 * legs with no comparison-specific structure. `buildComparisonContrast` adds a
 * deterministic, order-symmetric side-by-side attribute alignment. Because this
 * powers the GROUNDING_JSON the agent reasons over, the following invariants
 * MUST hold; any regression silently degrades comparison answers.
 *
 * Invariants verified (append-only, SOTA++ grade, numRuns=100):
 *  1. Determinism — buildComparisonContrast(x) deep-equals buildComparisonContrast(x).
 *  2. Order-symmetry — the verdict per attribute and the comparand identity set
 *     are invariant under input reordering (compare(A,B) ≡ compare(B,A)).
 *  3. Bounded comparands — never more than MAX_COMPARISON_COMPARANDS comparand
 *     ids regardless of input size.
 *  4. NFC on Korean labels — comparands whose categorical strings differ only by
 *     Unicode normal form (NFC vs NFD 한글) are reported as 'agree', not 'differ'.
 *  5. Missing-attribute safety — no facet ever carries NaN; absent attributes
 *     are recorded as present:false and never invent a numeric value.
 *  6. Entity dedup — duplicate entityIds collapse; a self-comparison degrades to
 *     the typed 'single' status, never a degenerate "A vs A" contrast.
 *  7. Empty / single — empty input → {status:'empty'}; one comparand →
 *     {status:'single'}; both are typed, never thrown.
 *
 * Touch-policy: regression-only, append-only. Never loosen the engine to make a
 * property pass.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildComparisonContrast,
  MAX_COMPARISON_COMPARANDS,
  type ComparisonContrast,
} from '../../src/domain/response/service/comparison-contrast.js';
import type { EntitySummary } from '../../src/domain/response/model/result-item.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';

const NUM_RUNS = 100;

// Korean wine surface labels (composed, NFC) used for Korean-case coverage.
const KOREAN_LABELS = [
  '오퍼스 원',
  '샤토 마고',
  '돔 페리뇽',
  '바롤로',
  '브루넬로',
  '리오하 그란 레세르바',
  '나파 카베르네',
] as const;

const KOREAN_REGIONS = ['보르도', '나파', '토스카나', '리오하', '부르고뉴'] as const;
const COUNTRIES = ['프랑스', '미국', '이탈리아', '스페인'] as const;
const WINE_TYPES = ['레드', '화이트', '스파클링'] as const;

function makeEntity(spec: {
  readonly id: string;
  readonly label?: string;
  readonly region?: string | undefined;
  readonly country?: string | undefined;
  readonly wineType?: string | undefined;
  readonly body?: number | undefined;
  readonly tannin?: number | undefined;
  readonly acidity?: number | undefined;
  readonly sweetness?: number | undefined;
  readonly criticScore?: number | undefined;
  readonly alcoholPct?: number | undefined;
  readonly vintage?: number | undefined;
}): EntitySummary {
  return {
    entityId: createCanonicalEntityId(spec.id),
    canonicalLabel: spec.label ?? spec.id,
    type: 'wine',
    ...(spec.region !== undefined ? { region: spec.region } : {}),
    ...(spec.country !== undefined ? { country: spec.country } : {}),
    ...(spec.wineType !== undefined ? { wineType: spec.wineType } : {}),
    ...(spec.body !== undefined ? { body: spec.body } : {}),
    ...(spec.tannin !== undefined ? { tannin: spec.tannin } : {}),
    ...(spec.acidity !== undefined ? { acidity: spec.acidity } : {}),
    ...(spec.sweetness !== undefined ? { sweetness: spec.sweetness } : {}),
    ...(spec.criticScore !== undefined ? { criticScore: spec.criticScore } : {}),
    ...(spec.alcoholPct !== undefined ? { alcoholPct: spec.alcoholPct } : {}),
    ...(spec.vintage !== undefined ? { vintage: spec.vintage } : {}),
  };
}

// Arbitrary entity with Korean labels/regions and optional (sometimes-missing)
// numeric attributes so missing-attribute safety is exercised on every run.
const entityArb: fc.Arbitrary<EntitySummary> = fc.record({
  id: fc.integer({ min: 1, max: 6 }).map((n) => `nx-wine-${n}`),
  label: fc.constantFrom(...KOREAN_LABELS),
  region: fc.option(fc.constantFrom(...KOREAN_REGIONS), { nil: undefined }),
  country: fc.option(fc.constantFrom(...COUNTRIES), { nil: undefined }),
  wineType: fc.option(fc.constantFrom(...WINE_TYPES), { nil: undefined }),
  body: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  tannin: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  acidity: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  sweetness: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  criticScore: fc.option(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  alcoholPct: fc.option(fc.double({ min: 5, max: 20, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  vintage: fc.option(fc.integer({ min: 1980, max: 2025 }), { nil: undefined }),
}).map(makeEntity);

const entitiesArb = fc.array(entityArb, { minLength: 0, maxLength: 8 });

function verdictsByAttribute(contrast: ComparisonContrast): Map<string, string> {
  const map = new Map<string, string>();
  if (contrast.status === 'contrasted') {
    for (const facet of contrast.facets) {
      map.set(facet.attribute, facet.verdict);
    }
  }
  return map;
}

describe('compare-wines contrast — property-based invariants', () => {
  it('1. determinism: identical input yields deep-equal contrast', () => {
    fc.assert(
      fc.property(entitiesArb, (entities) => {
        expect(buildComparisonContrast(entities)).toStrictEqual(buildComparisonContrast(entities));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('2. order-symmetry: per-attribute verdict + comparand id set invariant under reordering', () => {
    fc.assert(
      fc.property(entitiesArb, (entities) => {
        const reversed = [...entities].reverse();
        const a = buildComparisonContrast(entities);
        const b = buildComparisonContrast(reversed);
        // Status may legitimately differ when reordering changes which comparand
        // is first-seen for dedup (single vs single different id). For multi-id
        // inputs the contrasted facet verdicts must be order-invariant.
        if (a.status === 'contrasted' && b.status === 'contrasted') {
          expect(b.comparandIds).toStrictEqual(a.comparandIds);
          expect(verdictsByAttribute(b)).toStrictEqual(verdictsByAttribute(a));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('3. bounded comparands: never exceeds MAX_COMPARISON_COMPARANDS', () => {
    fc.assert(
      fc.property(
        fc.array(entityArb, { minLength: 0, maxLength: 12 }),
        (entities) => {
          const contrast = buildComparisonContrast(entities);
          if (contrast.status === 'contrasted') {
            expect(contrast.comparandIds.length).toBeLessThanOrEqual(MAX_COMPARISON_COMPARANDS);
            for (const facet of contrast.facets) {
              expect(facet.cells.length).toBeLessThanOrEqual(MAX_COMPARISON_COMPARANDS);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('5. missing-attribute safety: no NaN numeric values/spreads anywhere', () => {
    fc.assert(
      fc.property(entitiesArb, (entities) => {
        const contrast = buildComparisonContrast(entities);
        if (contrast.status !== 'contrasted') {
          return;
        }
        for (const facet of contrast.facets) {
          if (facet.numericSpread !== undefined) {
            expect(Number.isFinite(facet.numericSpread)).toBe(true);
          }
          for (const cell of facet.cells) {
            if (cell.present && cell.numericValue !== undefined) {
              expect(Number.isFinite(cell.numericValue)).toBe(true);
            }
            if (!cell.present) {
              expect(cell.numericValue).toBeUndefined();
              expect(cell.stringValue).toBeUndefined();
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('6. dedup: duplicate entityIds collapse', () => {
    fc.assert(
      fc.property(entityArb, fc.integer({ min: 2, max: 5 }), (entity, copies) => {
        const dupes = Array.from({ length: copies }, () => entity);
        const contrast = buildComparisonContrast(dupes);
        // All copies share one entityId → collapses to single.
        expect(contrast.status).toBe('single');
        if (contrast.status === 'single') {
          expect(contrast.entityId).toBe(entity.entityId);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('compare-wines contrast — Korean + edge cases', () => {
  it('4. NFC: Korean categorical values differing only by normal form agree', () => {
    const composed = '보르도'; // NFC
    const decomposed = composed.normalize('NFD'); // NFD jamo
    expect(composed).not.toBe(decomposed); // sanity: byte-distinct
    const contrast = buildComparisonContrast([
      makeEntity({ id: 'nx-a', region: composed }),
      makeEntity({ id: 'nx-b', region: decomposed }),
    ]);
    expect(contrast.status).toBe('contrasted');
    if (contrast.status === 'contrasted') {
      const regionFacet = contrast.facets.find((f) => f.attribute === 'region');
      expect(regionFacet?.verdict).toBe('agree');
    }
  });

  it('7. empty input → typed empty status', () => {
    expect(buildComparisonContrast([])).toStrictEqual({ status: 'empty' });
  });

  it('7. single comparand → typed single status', () => {
    const contrast = buildComparisonContrast([makeEntity({ id: 'nx-solo', label: '오퍼스 원' })]);
    expect(contrast).toStrictEqual({ status: 'single', entityId: createCanonicalEntityId('nx-solo') });
  });

  it('two Korean wines with differing body/tannin contrast as differ', () => {
    const contrast = buildComparisonContrast([
      makeEntity({ id: 'nx-barolo', label: '바롤로', body: 5, tannin: 5, region: '바롤로' }),
      makeEntity({ id: 'nx-brunello', label: '브루넬로', body: 3, tannin: 4, region: '브루넬로' }),
    ]);
    expect(contrast.status).toBe('contrasted');
    if (contrast.status === 'contrasted') {
      const bodyFacet = contrast.facets.find((f) => f.attribute === 'body');
      expect(bodyFacet?.verdict).toBe('differ');
      expect(bodyFacet?.numericSpread).toBe(2);
      expect(bodyFacet?.maxEntityId).toBe('nx-barolo');
      expect(bodyFacet?.minEntityId).toBe('nx-brunello');
      expect(contrast.divergentFacetCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('identical attributes across two distinct wines → agree facets', () => {
    const contrast = buildComparisonContrast([
      makeEntity({ id: 'nx-x', label: '돔 페리뇽', body: 3, country: '프랑스' }),
      makeEntity({ id: 'nx-y', label: '샤토 마고', body: 3, country: '프랑스' }),
    ]);
    expect(contrast.status).toBe('contrasted');
    if (contrast.status === 'contrasted') {
      const bodyFacet = contrast.facets.find((f) => f.attribute === 'body');
      expect(bodyFacet?.verdict).toBe('agree');
      expect(bodyFacet?.numericSpread).toBe(0);
      const countryFacet = contrast.facets.find((f) => f.attribute === 'country');
      expect(countryFacet?.verdict).toBe('agree');
    }
  });

  it('one-sided attribute (only A has tannin) → insufficient verdict, no spread', () => {
    const contrast = buildComparisonContrast([
      makeEntity({ id: 'nx-a', label: '바롤로', tannin: 5 }),
      makeEntity({ id: 'nx-b', label: '브루넬로' }),
    ]);
    expect(contrast.status).toBe('contrasted');
    if (contrast.status === 'contrasted') {
      const tanninFacet = contrast.facets.find((f) => f.attribute === 'tannin');
      expect(tanninFacet?.verdict).toBe('insufficient');
      expect(tanninFacet?.numericSpread).toBeUndefined();
    }
  });
});
