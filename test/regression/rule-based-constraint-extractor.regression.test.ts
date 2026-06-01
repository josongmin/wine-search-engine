/**
 * Regression tests for rule-based-constraint-extractor.ts — focused on the
 * formalized negation scope thresholds.
 *
 * Background:
 *   Previously, "not too tannic" / "no high tannin" / "안 단 와인" emitted no
 *   numeric ceiling. The extractor now emits a soft `tannin_max` or
 *   `sweetness_max` constraint using two named quantile cutoffs:
 *
 *     - NEGATION_SOFT_CAP_QUANTILE = 0.4
 *         "not too X" / "별로 안 X" — mild aversion; soft 40th-percentile ceiling.
 *     - NEGATION_HARD_CAP_QUANTILE = 0.25
 *         "no high X" / "low X only" / "안 X" — strong aversion; 25th-percentile.
 *
 * Append-only — never delete a regression test (CLAUDE.md).
 */

import { describe, it, expect } from 'vitest';
import {
  extractRuleBasedConstraints,
  NEGATION_SOFT_CAP_QUANTILE,
  NEGATION_HARD_CAP_QUANTILE,
} from '../../src/domain/query/service/rule-based-constraint-extractor.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findConstraint(
  bundle: ConstraintBundle,
  attribute: string,
  operator?: NormalizedConstraint['operator'],
): NormalizedConstraint | undefined {
  const pool = [...bundle.hard, ...bundle.soft, ...bundle.inferred];
  return pool.find(
    (c) => c.attribute === attribute && (operator === undefined || c.operator === operator),
  );
}

function findAll(
  bundle: ConstraintBundle,
  attribute: string,
): readonly NormalizedConstraint[] {
  const pool = [...bundle.hard, ...bundle.soft, ...bundle.inferred];
  return pool.filter((c) => c.attribute === attribute);
}

// ---------------------------------------------------------------------------
// Named quantile constants
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — named negation quantile constants', () => {
  it('exports NEGATION_SOFT_CAP_QUANTILE = 0.4 (40th percentile, mild aversion)', () => {
    expect(NEGATION_SOFT_CAP_QUANTILE).toBe(0.4);
  });

  it('exports NEGATION_HARD_CAP_QUANTILE = 0.25 (25th percentile, strong aversion)', () => {
    expect(NEGATION_HARD_CAP_QUANTILE).toBe(0.25);
  });

  it('hard cap is strictly stricter than soft cap (numerically lower ceiling)', () => {
    expect(NEGATION_HARD_CAP_QUANTILE).toBeLessThan(NEGATION_SOFT_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// English negation — soft cap
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — English negation soft cap', () => {
  it('"not too tannic" → tannin_max = NEGATION_SOFT_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('not too tannic');
    const c = findConstraint(bundle, 'tannin_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });

  it('"not too sweet" → sweetness_max = NEGATION_SOFT_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('not too sweet');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// English negation — hard cap
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — English negation hard cap', () => {
  it('"no high tannin" → tannin_max = NEGATION_HARD_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('no high tannin');
    const c = findConstraint(bundle, 'tannin_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"low tannin only" → tannin_max = NEGATION_HARD_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('low tannin only');
    const c = findConstraint(bundle, 'tannin_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"no sweet wines" → sweetness_max = NEGATION_HARD_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('no sweet wines');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// Korean particle 안 — short-form negation (HARD cap)
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — Korean particle 안 (hard cap)', () => {
  it('"안 단 와인" → sweetness_max = NEGATION_HARD_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('안 단 와인');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"안 떫은 와인" → tannin_max = NEGATION_HARD_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('안 떫은 와인');
    const c = findConstraint(bundle, 'tannin_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// Korean particle 못 — incapability negation
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — Korean particle 못', () => {
  it('"못 마실 정도로 강한" does not throw and returns a bundle', () => {
    expect(() => extractRuleBasedConstraints('못 마실 정도로 강한')).not.toThrow();
    const bundle = extractRuleBasedConstraints('못 마실 정도로 강한');
    expect(bundle).toHaveProperty('hard');
    expect(bundle).toHaveProperty('soft');
    expect(bundle).toHaveProperty('inferred');
  });

  it('"못 단 와인" handles 못 particle as hard-cap sweetness negation', () => {
    const bundle = extractRuleBasedConstraints('못 단 와인');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// Korean phrase 별로 안 — mild aversion (SOFT cap)
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — Korean phrase 별로 안 (soft cap)', () => {
  it('"별로 안 단 와인" → sweetness_max = NEGATION_SOFT_CAP_QUANTILE (less strict)', () => {
    const bundle = extractRuleBasedConstraints('별로 안 단 와인');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });

  it('"별로 안 떫은 와인" → tannin_max = NEGATION_SOFT_CAP_QUANTILE', () => {
    const bundle = extractRuleBasedConstraints('별로 안 떫은 와인');
    const c = findConstraint(bundle, 'tannin_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// Korean exclusion phrase 빼고
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — Korean exclusion 빼고', () => {
  it('"단 와인은 빼고" → emits a sweetness exclusion (sweetness_max hard cap)', () => {
    const bundle = extractRuleBasedConstraints('단 와인은 빼고');
    const c = findConstraint(bundle, 'sweetness_max', '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// Mixed positive + negative
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — mixed positive + negative', () => {
  it('"sweet but not too sweet" emits sweetness=sweet AND sweetness_max=soft cap', () => {
    const bundle = extractRuleBasedConstraints('sweet but not too sweet');
    const positives = findAll(bundle, 'sweetness');
    const cap = findConstraint(bundle, 'sweetness_max', '<=');
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.some((c) => c.operator === '>=' && typeof c.value === 'number')).toBe(true);
    expect(cap).toBeDefined();
    expect(cap?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });
});

// ---------------------------------------------------------------------------
// No-rule / empty
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — empty / no rules apply', () => {
  it('empty string → empty constraint bundle', () => {
    const bundle = extractRuleBasedConstraints('');
    expect(bundle.hard).toHaveLength(0);
    expect(bundle.soft).toHaveLength(0);
    expect(bundle.inferred).toHaveLength(0);
  });

  it('whitespace-only does not throw and produces empty bundle', () => {
    expect(() => extractRuleBasedConstraints('   \t\n  ')).not.toThrow();
    const bundle = extractRuleBasedConstraints('   \t\n  ');
    expect(bundle.hard).toHaveLength(0);
    expect(bundle.soft).toHaveLength(0);
  });

  it('"hello world" → no constraints extracted', () => {
    const bundle = extractRuleBasedConstraints('hello world');
    expect(bundle.hard).toHaveLength(0);
    expect(bundle.soft).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// False-positive guards
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — no false positives', () => {
  it('"this wine is not what I want" → no tannin/sweetness constraint', () => {
    const bundle = extractRuleBasedConstraints('this wine is not what I want');
    expect(findConstraint(bundle, 'tannin_max')).toBeUndefined();
    expect(findConstraint(bundle, 'sweetness_max')).toBeUndefined();
  });

  it('"sweet wine" (positive) → no sweetness_max negation cap emitted', () => {
    const bundle = extractRuleBasedConstraints('sweet wine');
    expect(findConstraint(bundle, 'sweetness_max')).toBeUndefined();
  });

  it('"tannic red wine" (positive) → no tannin_max negation cap emitted', () => {
    const bundle = extractRuleBasedConstraints('tannic red wine');
    expect(findConstraint(bundle, 'tannin_max')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adjacent regressions: determinism, particle variants, whitespace
// ---------------------------------------------------------------------------

describe('rule-based-constraint-extractor — determinism (5x)', () => {
  it('identical inputs yield identical bundles across 5 invocations', () => {
    const query = '별로 안 단 와인';
    const first = JSON.stringify(extractRuleBasedConstraints(query));
    for (let i = 0; i < 4; i++) {
      expect(JSON.stringify(extractRuleBasedConstraints(query))).toBe(first);
    }
  });

  it('mixed query "sweet but not too sweet" is deterministic across 5 runs', () => {
    const query = 'sweet but not too sweet';
    const first = JSON.stringify(extractRuleBasedConstraints(query));
    for (let i = 0; i < 4; i++) {
      expect(JSON.stringify(extractRuleBasedConstraints(query))).toBe(first);
    }
  });
});

describe('rule-based-constraint-extractor — Korean particle variants', () => {
  // Rule 8: no \b on Korean — these queries deliberately exercise the
  // Unicode-safe boundary assertions in the extractor.
  const variants: ReadonlyArray<readonly [string, string]> = [
    ['안 단 와인', 'sweetness_max'],
    ['못 단 와인', 'sweetness_max'],
    ['단 와인 없이', 'sweetness_max'],
    ['단 와인 빼고', 'sweetness_max'],
    ['단 와인 말고', 'sweetness_max'],
  ];

  for (const [query, expectedAttribute] of variants) {
    it(`"${query}" emits ${expectedAttribute} cap`, () => {
      const bundle = extractRuleBasedConstraints(query);
      const c = findConstraint(bundle, expectedAttribute, '<=');
      expect(c).toBeDefined();
    });
  }
});

describe('rule-based-constraint-extractor — robustness', () => {
  it('does not throw on Korean+English mixed query', () => {
    expect(() =>
      extractRuleBasedConstraints('not too sweet 그리고 별로 안 단 와인'),
    ).not.toThrow();
  });

  it('does not throw on emoji-laden query', () => {
    expect(() => extractRuleBasedConstraints('not too tannic 🍷🍷')).not.toThrow();
  });
});
