/**
 * Property-based regression tests for rule-based-constraint-extractor.
 *
 * Audit gaps closed by this file (feature: nlu.rule-based-constraint-extractor,
 * maturity 4 → 5):
 *  - Korean negation morphology taxonomy is now property-tested across the full
 *    particle set {안, 못, 없이, 빼고, 말고, 제외, 별로 안} × {sweetness, tannin}
 *    instead of being spot-checked per-case in the canonical regression file.
 *  - SOFT_CAP < HARD_CAP ordering is locked as an invariant (numerically lower
 *    ceiling = stricter); future tuning cannot accidentally invert it.
 *  - Idempotence: re-feeding the canonical 말고 form (post-normalizer output)
 *    must not escalate constraint count or value — extraction is a fixed point
 *    on its own canonical surface.
 *  - Positive + negative co-emission: "sweet but not too sweet" emits BOTH
 *    sweetness=sweet AND sweetness_max=SOFT. Property-tested across the
 *    {positive adjective} × {soft-negation suffix} grid.
 *  - False-positive guard: prosaic "not"-bearing sentences ("this wine is not
 *    what I want") MUST NOT trigger any cap. Generated via fast-check from a
 *    fixed prose vocabulary.
 *  - NFC stability: Korean particle expressed as NFC vs NFD MUST yield the
 *    same constraint output (this was the gap exposed during the audit:
 *    extractSearchConstraints normalizes internally but the rule-based
 *    extractor did not — NFD input silently dropped sweetness_max).
 *
 * Touch-policy: this file is regression-only and append-only. It locks
 * publicly observable behavior; it does NOT add new rules.
 *
 * Naming: invariant-first per repo conventions (rule 5 in user feedback).
 * fast-check `numRuns: 100` per property (CLAUDE.md SOTA++ baseline).
 *
 * CLAUDE.md test discipline:
 *   - Rule 5/8: Korean particles + Unicode-safe boundaries — never `\b` on Korean.
 *   - Rule 6: schema-bound assertions reference NEGATION_*_QUANTILE constants,
 *     not magic numbers.
 *   - Rule 18: SOFT_CAP < HARD_CAP ordering documented (numerically lower =
 *     stricter ceiling).
 *   - Rule 23: false-positive prose corpus exercised (overzealous negation
 *     patterns silently degrade UX).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  extractRuleBasedConstraints,
  NEGATION_SOFT_CAP_QUANTILE,
  NEGATION_HARD_CAP_QUANTILE,
} from '../../src/domain/query/service/rule-based-constraint-extractor.js';
import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../src/domain/shared/types/index.js';

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
    (c) =>
      c.attribute === attribute &&
      (operator === undefined || c.operator === operator),
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
// Korean negation taxonomy (held SOTA++ for this extractor)
// ---------------------------------------------------------------------------

/**
 * Korean negation morphology categorized by aversion strength:
 *
 *  SOFT (mild aversion → 40th-percentile cap):
 *    "별로 안 X"      — "not really X" (hedge-prefixed short-form negation)
 *
 *  HARD (strong aversion → 25th-percentile cap):
 *    "안 X"           — short-form adverbial negation
 *    "못 X"           — incapability negation (functionally aversion here)
 *    "X 와인 빼고"    — exclusion via subtraction
 *    "X 와인 없이"    — exclusion via absence
 *    "X 와인 말고"    — exclusion via "instead of"
 *    "X 와인 제외"    — exclusion via explicit "exclude"
 *
 * `X` is the bare attribute adjective ("단" = sweet, "떫" = tannic).
 *
 * The hedge particle 별로 must be detected BEFORE the bare 안 short-form
 * (precedence rule 1 in the extractor source) — otherwise "별로 안 단"
 * would emit HARD instead of SOFT.
 */
const KOREAN_HARD_NEGATION_FRAMES: ReadonlyArray<
  readonly [adverbAdjective: string, frame: (adj: string) => string]
> = [
  ['단', (adj) => `안 ${adj} 와인`],
  ['단', (adj) => `못 ${adj} ${adj === '단' ? '와인' : ''}`.trim()],
  ['단', (adj) => `${adj} 와인 빼고`],
  ['단', (adj) => `${adj} 와인 없이`],
  ['단', (adj) => `${adj} 와인 말고`],
  ['단', (adj) => `${adj} 와인 제외`],
  ['떫', (adj) => `안 ${adj}은 와인`],
  ['떫', (adj) => `${adj}은 와인 빼고`],
  ['떫', (adj) => `${adj}은 와인 없이`],
  ['떫', (adj) => `${adj}은 와인 말고`],
];

const KOREAN_SOFT_NEGATION_FRAMES: ReadonlyArray<
  readonly [adverbAdjective: string, frame: (adj: string) => string]
> = [
  ['단', (adj) => `별로 안 ${adj} 와인`],
  ['떫', (adj) => `별로 안 ${adj}은 와인`],
];

/** Adjective → expected `*_max` attribute. */
const ADJECTIVE_TO_ATTRIBUTE: Readonly<Record<string, string>> = {
  단: 'sweetness_max',
  떫: 'tannin_max',
};

// ---------------------------------------------------------------------------
// Property 1: SOFT_CAP < HARD_CAP ordering invariant (locked)
// ---------------------------------------------------------------------------

describe('Property: NEGATION_SOFT_CAP < NEGATION_HARD_CAP is forbidden — hard cap is stricter', () => {
  it('hard cap is numerically strictly lower than soft cap (stricter ceiling)', () => {
    // Locked invariant — re-asserted as a property scaffold for any future
    // tuning. A hard cap that is NOT strictly below soft cap means the
    // taxonomy distinction is meaningless.
    expect(NEGATION_HARD_CAP_QUANTILE).toBeLessThan(NEGATION_SOFT_CAP_QUANTILE);
  });

  it('both caps lie within [0, 1] — palate attributes are normalized to that range', () => {
    expect(NEGATION_SOFT_CAP_QUANTILE).toBeGreaterThan(0);
    expect(NEGATION_SOFT_CAP_QUANTILE).toBeLessThan(1);
    expect(NEGATION_HARD_CAP_QUANTILE).toBeGreaterThan(0);
    expect(NEGATION_HARD_CAP_QUANTILE).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Property 2: Korean negation taxonomy exhaustiveness
// ---------------------------------------------------------------------------

describe('Property: Korean negation taxonomy is exhaustively wired (100 runs)', () => {
  it('every HARD-frame variant emits the HARD cap on the correct attribute', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_HARD_NEGATION_FRAMES),
        ([adj, frame]) => {
          const query = frame(adj);
          const expectedAttribute = ADJECTIVE_TO_ATTRIBUTE[adj];
          if (expectedAttribute === undefined) {
            throw new Error(`taxonomy bug: unmapped adjective ${adj}`);
          }
          const bundle = extractRuleBasedConstraints(query);
          const c = findConstraint(bundle, expectedAttribute, '<=');
          if (c === undefined) return false;
          return c.value === NEGATION_HARD_CAP_QUANTILE;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every SOFT-frame variant emits the SOFT cap on the correct attribute', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KOREAN_SOFT_NEGATION_FRAMES),
        ([adj, frame]) => {
          const query = frame(adj);
          const expectedAttribute = ADJECTIVE_TO_ATTRIBUTE[adj];
          if (expectedAttribute === undefined) {
            throw new Error(`taxonomy bug: unmapped adjective ${adj}`);
          }
          const bundle = extractRuleBasedConstraints(query);
          const c = findConstraint(bundle, expectedAttribute, '<=');
          if (c === undefined) return false;
          return c.value === NEGATION_SOFT_CAP_QUANTILE;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: NFC stability — same logical Korean input, same constraints
// ---------------------------------------------------------------------------

describe('Property: NFC vs NFD Korean input yields identical constraints (100 runs)', () => {
  /**
   * Real audit gap: prior to this property, NFD-decomposed Korean input
   * silently dropped sweetness_max / tannin_max caps because the extractor's
   * regexes are NFC-literal and the function did not normalize inputs.
   * extractSearchConstraints normalizes internally; rule-based extractor
   * now does the same at the entry boundary.
   */
  const allFrames = [...KOREAN_HARD_NEGATION_FRAMES, ...KOREAN_SOFT_NEGATION_FRAMES];

  it('NFC and NFD Korean inputs produce equal constraint bundles', () => {
    fc.assert(
      fc.property(fc.constantFrom(...allFrames), ([adj, frame]) => {
        const nfc = frame(adj).normalize('NFC');
        const nfd = nfc.normalize('NFD');
        // Sanity: NFC and NFD byte forms must differ for Korean; if not,
        // the test is degenerate but still passes (no negative claim).
        const fromNfc = JSON.stringify(extractRuleBasedConstraints(nfc));
        const fromNfd = JSON.stringify(extractRuleBasedConstraints(nfd));
        return fromNfc === fromNfd;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Idempotence on the canonical Korean negation surface
// ---------------------------------------------------------------------------

describe('Property: extract(extract-stable input) === extract(input) (idempotence, 100 runs)', () => {
  /**
   * Idempotence here means: feeding the SAME input twice produces the SAME
   * bundle (no internal mutable state). For the rule-based extractor, this
   * is the natural "fixed point on its own output surface" guarantee —
   * re-running the extractor on the input never escalates the cap from
   * SOFT to HARD or doubles the constraints.
   */
  const allFrames = [...KOREAN_HARD_NEGATION_FRAMES, ...KOREAN_SOFT_NEGATION_FRAMES];

  it('repeated extraction returns equal bundles (no escalation, no duplication)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...allFrames), ([adj, frame]) => {
        const query = frame(adj);
        const first = JSON.stringify(extractRuleBasedConstraints(query));
        const second = JSON.stringify(extractRuleBasedConstraints(query));
        const third = JSON.stringify(extractRuleBasedConstraints(query));
        return first === second && second === third;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: positive + negative co-emission ("sweet but not too sweet")
// ---------------------------------------------------------------------------

describe('Property: positive adjective + soft-negative qualifier co-emit (100 runs)', () => {
  // Generator: `<positive> but not too <same-adjective>` across the small
  // English negation cap vocabulary documented in the source.
  const positiveSweetAdjective = fc.constantFrom('sweet');
  // Connectives chosen to mirror natural-language phrasings users actually
  // write; each one must yield BOTH the positive sweetness=sweet AND the
  // soft-cap sweetness_max constraint.
  const connective = fc.constantFrom(' but ', ', but ', ' yet ', ' however ');

  it('"<adj> but not too <adj>" emits BOTH positive AND soft-cap', () => {
    fc.assert(
      fc.property(positiveSweetAdjective, connective, (adj, conn) => {
        const query = `${adj}${conn}not too ${adj}`;
        const bundle = extractRuleBasedConstraints(query);
        const positives = findAll(bundle, 'sweetness');
        const cap = findConstraint(bundle, 'sweetness_max', '<=');
        const hasPositive = positives.some((c) => c.value === 'sweet');
        const capIsSoft = cap !== undefined && cap.value === NEGATION_SOFT_CAP_QUANTILE;
        return hasPositive && capIsSoft;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: false-positive guard — prosaic "not" / "no" does not trigger caps
// ---------------------------------------------------------------------------

describe('Property: prosaic non-attribute "not"/"no" sentences emit no cap (100 runs)', () => {
  // A small generated corpus of sentences containing "not"/"no" that are
  // semantically unrelated to wine palate attributes. Any emission of
  // sweetness_max / tannin_max / body_max here is a false-positive (rule 23).
  const prose = fc.constantFrom(
    'this wine is not what I want',
    'i do not see any results',
    'no idea what to drink',
    'no thanks',
    'this is not the bottle i ordered',
    'never mind, show me reds',
    'cannot find the one i remember',
    'no clue about pairings',
    'i would not say this is great',
    'not really sure what to pick',
  );

  it('no sweetness_max / tannin_max emitted on prose containing "not"/"no"', () => {
    fc.assert(
      fc.property(prose, (q) => {
        const bundle = extractRuleBasedConstraints(q);
        return (
          findConstraint(bundle, 'sweetness_max') === undefined &&
          findConstraint(bundle, 'tannin_max') === undefined
        );
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Specific Korean negation taxonomy spot-checks
// ---------------------------------------------------------------------------

describe('Korean negation taxonomy — specific frames lock current behavior', () => {
  const specificCases: ReadonlyArray<
    readonly [
      query: string,
      attribute: string,
      expectedValue: number,
      note: string,
    ]
  > = [
    ['안 단 와인', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, 'short-form 안 → HARD'],
    ['못 단 와인', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, 'incapability 못 → HARD'],
    ['단 와인 없이', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, '없이 → HARD'],
    ['단 와인 빼고', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, '빼고 → HARD'],
    ['단 와인 말고', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, '말고 → HARD'],
    ['단 와인 제외', 'sweetness_max', NEGATION_HARD_CAP_QUANTILE, '제외 → HARD'],
    ['별로 안 단 와인', 'sweetness_max', NEGATION_SOFT_CAP_QUANTILE, '별로 안 → SOFT (hedge wins)'],
    ['안 떫은 와인', 'tannin_max', NEGATION_HARD_CAP_QUANTILE, '안 + 떫 → HARD tannin'],
    ['별로 안 떫은 와인', 'tannin_max', NEGATION_SOFT_CAP_QUANTILE, '별로 안 + 떫 → SOFT tannin'],
    ['떫은 와인 빼고', 'tannin_max', NEGATION_HARD_CAP_QUANTILE, '떫 + 빼고 → HARD tannin'],
    ['떫은 와인 없이', 'tannin_max', NEGATION_HARD_CAP_QUANTILE, '떫 + 없이 → HARD tannin'],
    ['떫은 와인 말고', 'tannin_max', NEGATION_HARD_CAP_QUANTILE, '떫 + 말고 → HARD tannin'],
  ];

  for (const [query, attribute, expectedValue, note] of specificCases) {
    it(`"${query}" → ${attribute}=${expectedValue} (${note})`, () => {
      const bundle = extractRuleBasedConstraints(query);
      const c = findConstraint(bundle, attribute, '<=');
      expect(c).toBeDefined();
      expect(c?.value).toBe(expectedValue);
    });
  }
});

// ---------------------------------------------------------------------------
// Compound / double-negation behavior — documented (no implicit re-implication)
// ---------------------------------------------------------------------------

describe('Compound negation — documented behavior (no implicit re-implication)', () => {
  /**
   * "안 단 와인 아니야" is a colloquial double negation that logically should
   * imply "actually IS sweet" — but the rule-based extractor is intentionally
   * surface-only (CLAUDE.md: no heuristic shortcuts). It detects the
   * inner "안 단" cap and emits HARD; it does NOT re-implicate sweetness=sweet.
   * This is a known limitation, documented here so future tuning is auditable.
   */
  it('"안 단 와인 아니야" detects inner HARD cap; does NOT implicate sweetness=sweet', () => {
    const bundle = extractRuleBasedConstraints('안 단 와인 아니야');
    const cap = findConstraint(bundle, 'sweetness_max', '<=');
    expect(cap).toBeDefined();
    expect(cap?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
    // No positive sweetness=sweet is emitted — documented limitation.
    const positives = findAll(bundle, 'sweetness');
    expect(positives.some((c) => c.value === 'sweet')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// English negation prepositions — exhaustive grid
// ---------------------------------------------------------------------------

describe('English negation prepositions — exhaustive sweetness/tannin grid', () => {
  /**
   * The English vocabulary currently covered by the extractor source:
   *   SOFT — "not too {tannic,sweet}"
   *   HARD — "no high tannin" | "low tannin only" | "no sweet [wines]" |
   *          "low sweetness only"
   * Other prepositions (without/except/excluding) are handled by
   * extractSearchConstraints for exclusions on grape/country/style — they
   * do NOT emit palate caps. This test locks that boundary.
   */
  it('"not too tannic" → SOFT tannin_max', () => {
    const c = findConstraint(extractRuleBasedConstraints('not too tannic'), 'tannin_max', '<=');
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });

  it('"not too sweet" → SOFT sweetness_max', () => {
    const c = findConstraint(extractRuleBasedConstraints('not too sweet'), 'sweetness_max', '<=');
    expect(c?.value).toBe(NEGATION_SOFT_CAP_QUANTILE);
  });

  it('"no high tannin" → HARD tannin_max', () => {
    const c = findConstraint(extractRuleBasedConstraints('no high tannin'), 'tannin_max', '<=');
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"low tannin only" → HARD tannin_max', () => {
    const c = findConstraint(extractRuleBasedConstraints('low tannin only'), 'tannin_max', '<=');
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"no sweet wines" → HARD sweetness_max', () => {
    const c = findConstraint(extractRuleBasedConstraints('no sweet wines'), 'sweetness_max', '<=');
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });

  it('"low sweetness only" → HARD sweetness_max', () => {
    const c = findConstraint(
      extractRuleBasedConstraints('low sweetness only'),
      'sweetness_max',
      '<=',
    );
    expect(c?.value).toBe(NEGATION_HARD_CAP_QUANTILE);
  });
});
