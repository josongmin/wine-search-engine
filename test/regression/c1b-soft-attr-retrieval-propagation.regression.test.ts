/**
 * C1b regression — Soft attribute constraints propagate to Vespa retrieval.
 *
 * Pre-C1b failure (probe-search-quality 2026-05-23):
 *   - "저알콜 와인" → top-3 high-ABV reds (저알콜 ignored)
 *   - "달콤한 화이트 와인" → top-3 reds (sweetness ignored even for explicit ceiling)
 *   - "과일향 와인" → generic Cabernets (flavor_profile ignored)
 *
 * RCA: `nl-mapper.ts` extracted the soft constraints correctly
 * (e.g. "저알콜" → `alcohol_pct <= 12`, confidence=0.86,
 * mapping_version='v1.0'), but `softConstraintsToOptionalFilterTokens`
 * dropped them at three independent gates:
 *
 *   1. `mapping_version='v1.0'` (curated nl-mapper) was NOT in the trust list
 *      (only `rule-based-v1.0` / `entity-resolver-v1.0` qualified).
 *   2. `alcohol_pct`, `sweetness`, `flavor_profile`, `certification` were
 *      NOT in the promotion attribute allow-list (only
 *      `critic_score`, `body`, `producer_prestige`).
 *   3. The function only emitted MIN bounds; soft ceilings like
 *      `alcohol_pct <= 12` ("저알콜") and `sweetness <= 0.2` ("드라이") had
 *      no MAX-bound translation.
 *
 * C1b fix (this regression pins all three legs):
 *
 *   - Curated nl-mapper version `'v1.0'` joins the trust list.
 *   - `SOFT_PROMOTION_TOKEN_SPEC` replaces the MIN-only attribute map with a
 *     per-attribute spec carrying optional `minKey`, `maxKey`, `stringKey`.
 *   - `alcohol_pct` / `sweetness` get symmetric MIN+MAX promotion;
 *     `flavor_profile` / `certification` get string-contains promotion.
 *   - MIN-only attributes (`critic_score`, `body`, `producer_prestige`, etc.)
 *     remain MIN-only by omitting `maxKey` — the P1.A invariant survives.
 *
 * This file is append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { softConstraintsToOptionalFilterTokens } from '../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import { NLMapper, toNormalizedConstraint } from '../../src/domain/attribute/service/nl-mapper.js';
import { buildSparseFilters } from '../../src/infrastructure/vespa/mapping.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';

class NullMappingTable {
  async findMapping(): Promise<null> {
    return null;
  }
}

/**
 * Trust list mirrors the legacy pre-canonicalization gate so the C1b regression
 * invariants ("v1.0 curated promotes / LLM rogue does not") still hold under the
 * new `soft_promotion_authority` contract: trusted mapping versions get
 * `authority='allow'`; LLM/unknown versions do not, preserving the rejection
 * cases at lines 142/152 without renaming them.
 */
const TRUSTED_MAPPING_VERSIONS: ReadonlySet<string> = new Set([
  'rule-based-v1.0',
  'entity-resolver-v1.0',
  'v1.0',
]);

function makeSoft(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  overrides: Partial<NormalizedConstraint> = {},
): NormalizedConstraint {
  const merged: NormalizedConstraint = {
    attribute,
    operator,
    value,
    source_phrase: attribute,
    confidence: 0.85,
    mapping_version: 'v1.0',
    ...overrides,
  };
  if (!('soft_promotion_authority' in overrides)
      && merged.mapping_version !== undefined
      && TRUSTED_MAPPING_VERSIONS.has(merged.mapping_version)) {
    return { ...merged, soft_promotion_authority: 'allow' };
  }
  return merged;
}

describe('C1b — soft attribute → Vespa retrieval filter propagation', () => {
  const mapper = new NLMapper(new NullMappingTable());

  /**
   * Mirror the production pre-route-phase step that attaches
   * `soft_promotion_authority='allow'` to sensory soft constraints whose Vespa
   * fields are available — see {@link
   * src/application/search/search-usecase-pre-route-phase.ts}. NLMapper itself
   * is a curated/trusted producer, so for an end-to-end fixture run we
   * unconditionally tag every constraint as production would for an available
   * sensory attribute. Without this step the new gate denies the promotion.
   */
  const withAuthority = (c: NormalizedConstraint): NormalizedConstraint => ({
    ...c,
    soft_promotion_authority: 'allow',
  });

  describe('end-to-end: nl-mapper output → promotion token', () => {
    it('"저알콜" extracts and promotes to alcohol_max:12', async () => {
      const mapping = await mapper.mapPhrase('저알콜');
      expect(mapping).not.toBeNull();
      const constraint = toNormalizedConstraint(mapping!);
      expect(constraint.attribute).toBe('alcohol_pct');
      expect(constraint.operator).toBe('<=');
      expect(constraint.value).toBe(12);
      // Confidence MUST clear the 0.8 promotion floor for the structural fix
      // to actually fire. If a future tuning drops 저알콜 below 0.8 the
      // promotion silently no-ops and this regression catches it.
      expect(constraint.confidence).toBeGreaterThanOrEqual(0.8);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('alcohol_max:12');
    });

    it('"저알코올" (alt spelling) extracts and promotes to alcohol_max:12', async () => {
      const mapping = await mapper.mapPhrase('저알코올');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('alcohol_max:12');
    });

    it('"도수 낮은" extracts and promotes to alcohol_max:12', async () => {
      const mapping = await mapper.mapPhrase('도수 낮은');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('alcohol_max:12');
    });

    it('"드라이" extracts and promotes to sweetness_max:0.2', async () => {
      const mapping = await mapper.mapPhrase('드라이');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('sweetness_max:0.2');
    });

    it('"달지 않은" extracts and promotes to sweetness_max:0.2', async () => {
      const mapping = await mapper.mapPhrase('달지 않은');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('sweetness_max:0.2');
    });

    it('"달달한" extracts and promotes to sweetness_min:0.5', async () => {
      const mapping = await mapper.mapPhrase('달달한');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('sweetness_min:0.5');
    });

    it('"과일향" extracts and promotes to flavor_profile:fruity', async () => {
      const mapping = await mapper.mapPhrase('과일향');
      const constraint = toNormalizedConstraint(mapping!);
      const tokens = softConstraintsToOptionalFilterTokens([withAuthority(constraint)]);
      expect(tokens).toContain('flavor_profile:fruity');
    });
  });

  describe('curated mapping version (v1.0) is trusted for promotion', () => {
    it('mapping_version=v1.0 with high confidence promotes', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '<=', 12, { confidence: 0.86, mapping_version: 'v1.0' }),
      ]);
      expect(tokens).toEqual(['alcohol_max:12']);
    });

    it('mapping_version=v1.0 below confidence floor (0.8) is still rejected', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '<=', 12, { confidence: 0.7, mapping_version: 'v1.0' }),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('unknown mapping_version is still rejected (trust list is closed)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '<=', 12, {
          confidence: 0.95,
          mapping_version: 'rogue-mapper-v9',
        }),
      ]);
      expect(tokens).toHaveLength(0);
    });

    it('llm-sourced mapping_version is still rejected even for promotable attribute', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '<=', 12, {
          confidence: 0.95,
          mapping_version: 'llm-linker-v1.0',
        }),
      ]);
      expect(tokens).toHaveLength(0);
    });
  });

  describe('symmetric numeric attributes (alcohol_pct, sweetness) — MIN + MAX', () => {
    it('alcohol_pct <= N → alcohol_max:N (MAX bound)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '<=', 12),
      ]);
      expect(tokens).toEqual(['alcohol_max:12']);
    });

    it('alcohol_pct >= N → alcohol_min:N (MIN bound)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '>=', 14),
      ]);
      expect(tokens).toEqual(['alcohol_min:14']);
    });

    it('alcohol_pct = N → alcohol_min:N (treated as floor, not pinpoint)', () => {
      // `=` numeric is treated as a MIN floor (matches existing critic_score `=` semantics).
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', '=', 13),
      ]);
      expect(tokens).toContain('alcohol_min:13');
    });

    it('alcohol_pct range { min, max } → both bounds', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', 'range', { min: 10, max: 14 }),
      ]);
      expect(tokens).toEqual(['alcohol_min:10', 'alcohol_max:14']);
    });

    it('alcohol_pct range with REVERSED bounds normalises lo/hi', () => {
      // Defensive — { min: 14, max: 10 } would otherwise emit
      // alcohol_min:14 AND alcohol_max:10 → always-false YQL filter.
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol_pct', 'range', { min: 14, max: 10 }),
      ]);
      expect(tokens).toEqual(['alcohol_min:10', 'alcohol_max:14']);
    });

    it('legacy `alcohol` attribute name also promotes (alias for alcohol_pct)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('alcohol', '<=', 11),
      ]);
      expect(tokens).toEqual(['alcohol_max:11']);
    });

    it('sweetness <= 0.2 → sweetness_max:0.2', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('sweetness', '<=', 0.2),
      ]);
      expect(tokens).toEqual(['sweetness_max:0.2']);
    });

    it('sweetness >= 0.5 → sweetness_min:0.5', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('sweetness', '>=', 0.5),
      ]);
      expect(tokens).toEqual(['sweetness_min:0.5']);
    });
  });

  describe('MIN-only attributes preserve P1.A invariant', () => {
    // P1.A regression guard: `critic_score`, `producer_prestige`,
    // `gift_suitability`, `beginner_suitability` MUST NOT promote MAX bounds
    // — promoting `critic_score <= 0.9` would silently exclude top-rated wines.
    //
    // NOTE: `body` was originally MIN-only here, but the product evolved to
    // treat body as a symmetric sensory attribute (a user saying "light body"
    // is a legitimate MAX ceiling, mirroring `sweetness` and `acidity` which
    // are already in {@link SENSORY_SOFT_PROMOTION_ATTRIBUTES}). Body's
    // symmetric promotion is now covered by the colocated unit test
    // `soft body ceiling with promotion authority emits body_max token` —
    // this regression preserves the original ceiling-protection invariant
    // for the truly MIN-only attributes only.
    const minOnlyAttrs = [
      'critic_score',
      'producer_prestige',
      'gift_suitability',
      'beginner_suitability',
    ] as const;

    for (const attr of minOnlyAttrs) {
      it(`${attr} <= N does NOT promote (no maxKey in spec)`, () => {
        const tokens = softConstraintsToOptionalFilterTokens([
          makeSoft(attr, '<=', 0.5, { mapping_version: 'rule-based-v1.0' }),
        ]);
        expect(tokens.some((t) => t.endsWith('_max:0.5'))).toBe(false);
      });

      it(`${attr} >= N promotes to ${attr}_min`, () => {
        const tokens = softConstraintsToOptionalFilterTokens([
          makeSoft(attr, '>=', 0.7, { mapping_version: 'rule-based-v1.0' }),
        ]);
        // Source-of-truth token key shape: `<attr>_min`.
        expect(tokens.some((t) => t.startsWith(`${attr}_min:`))).toBe(true);
      });

      it(`${attr} range emits ONLY the MIN bound (no MAX)`, () => {
        const tokens = softConstraintsToOptionalFilterTokens([
          makeSoft(attr, 'range', { min: 0.5, max: 0.9 }, {
            mapping_version: 'rule-based-v1.0',
          }),
        ]);
        expect(tokens.some((t) => t.startsWith(`${attr}_min:`))).toBe(true);
        expect(tokens.some((t) => t.includes('_max:'))).toBe(false);
      });
    }
  });

  describe('string-contains attributes (flavor_profile, certification)', () => {
    it('flavor_profile = "fruity" → flavor_profile:fruity', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('flavor_profile', '=', 'fruity'),
      ]);
      expect(tokens).toEqual(['flavor_profile:fruity']);
    });

    it('flavor_profile in ["fruity"] (singleton from nl-mapper) → flavor_profile:fruity', () => {
      // nl-mapper toNormalizedConstraint() wraps single-value `in` as
      // a one-element array. The promotion must handle that shape.
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('flavor_profile', 'in', ['fruity']),
      ]);
      expect(tokens).toEqual(['flavor_profile:fruity']);
    });

    it('flavor_profile in ["fruity", "oaky"] → flavor_profile_in:fruity|oaky (OR)', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('flavor_profile', 'in', ['fruity', 'oaky']),
      ]);
      expect(tokens).toEqual(['flavor_profile_in:fruity|oaky']);
    });

    it('flavor_profile values with pipe characters are stripped (injection guard)', () => {
      // Pipe is the buildSparseFilters multi-value delimiter — leaking it
      // through a single value would split into two filter terms.
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('flavor_profile', '=', 'fru|ity'),
      ]);
      expect(tokens).toEqual(['flavor_profile:fruity']);
    });

    it('certification = "vegan" → certification:vegan', () => {
      const tokens = softConstraintsToOptionalFilterTokens([
        makeSoft('certification', '=', 'vegan'),
      ]);
      expect(tokens).toEqual(['certification:vegan']);
    });
  });

  describe('Vespa YQL emission — promoted tokens produce valid filter clauses', () => {
    it('alcohol_max:12 token compiles to `alcohol_pct <= 12.00` YQL', () => {
      const yql = buildSparseFilters(['alcohol_max:12']);
      // Token clamps to 2 decimals per FILTER_TOKEN_REGISTRY spec.
      expect(yql).toContain('alcohol_pct <= 12.00');
    });

    it('sweetness_max:0.2 token compiles to `sweetness <= 0.200` YQL', () => {
      const yql = buildSparseFilters(['sweetness_max:0.2']);
      expect(yql).toContain('sweetness <= 0.200');
    });

    it('sweetness_min:0.5 token compiles to `sweetness >= 0.500` YQL', () => {
      const yql = buildSparseFilters(['sweetness_min:0.5']);
      expect(yql).toContain('sweetness >= 0.500');
    });

    it('flavor_profile:fruity compiles to flavor_profiles contains "fruity"', () => {
      const yql = buildSparseFilters(['flavor_profile:fruity']);
      expect(yql).toContain('flavor_profiles contains "fruity"');
    });

    it('certification:vegan compiles to certifications contains "vegan"', () => {
      const yql = buildSparseFilters(['certification:vegan']);
      expect(yql).toContain('certifications contains "vegan"');
    });
  });

  describe('regression guards — attributes NOT in promotion spec stay soft', () => {
    // These attributes are still SOFT_CONSTRAINT_ATTRIBUTES but intentionally
    // excluded from promotion. They MUST NOT emit any retrieval tokens —
    // their semantics are either two-sided (drinking_window), categorical
    // (style, price_band), or already MIN-handled elsewhere.
    const nonPromotableSoftAttrs = [
      ['drinking_window', '>=', 2025],
      ['style', '=', 'bold'],
      ['price_band', '=', 'premium'],
      ['occasion', '=', 'gift'],
      ['closure', '=', 'screw cap'],
    ] as const;

    for (const [attr, op, val] of nonPromotableSoftAttrs) {
      it(`${attr} ${op} ${String(val)} does NOT promote`, () => {
        const tokens = softConstraintsToOptionalFilterTokens([
          makeSoft(
            attr,
            op as NormalizedConstraint['operator'],
            val,
            { mapping_version: 'rule-based-v1.0' },
          ),
        ]);
        expect(tokens).toHaveLength(0);
      });
    }
  });
});
