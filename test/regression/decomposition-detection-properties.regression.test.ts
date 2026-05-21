/**
 * Property-based regression: nlu.decomposition-detection (SOTA++ grade)
 *
 * Companion to decomposition-detection.regression.test.ts (35 example-based
 * cases). Where that suite pins specific surfaces, THIS suite asserts
 * *invariants* that must hold across the entire input space of comparison
 * queries — comparison-marker exhaustiveness, determinism, leg non-emptiness,
 * Korean particle robustness, pairwise scope, and (mandatory) false-positive
 * guards against prosaic queries that merely contain connector words.
 *
 * The detector (decomposition-detector.ts) is deliberately surface-pattern
 * based. These properties lock the contract that:
 *   - EVERY documented comparison marker decomposes an {A,B} entity pair into
 *     exactly two non-empty legs whose raw text equals A and B.
 *   - Prosaic queries with embedded connector words (Korean 와/과/랑/하고 used as
 *     "with", English "compared to" / "or" without a cue) do NOT decompose.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the detector.
 * Any property that cannot hold is documented as a known_limitation in
 * tools/feature-catalog/features/nlu/decomposition-detection.yaml — never
 * loosen the detector to make a property pass.
 *
 * fast-check numRuns: 100 (per property). Korean + English both covered.
 * No `\b` on Korean content (CLAUDE.md rule 8).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { detectDecomposition } from '../../src/domain/query/service/decomposition-detector.js';

const FC_RUNS = 100;

/**
 * Entity surfaces that the detector splits cleanly on the LEFT/RIGHT of a
 * comparison marker. These are deliberately multi-script (Latin proper nouns,
 * single-token regions, Hangul region aliases) but contain NO comparison cue
 * words themselves, so they cannot accidentally re-trigger the matcher.
 */
const COMPARISON_ENTITIES: readonly string[] = [
  'Opus One',
  'Screaming Eagle',
  'Almaviva',
  'Sassicaia',
  'Bordeaux',
  'Burgundy',
  'Margaux',
  'Pauillac',
  '보르도',
  '부르고뉴',
] as const;

/**
 * Builders for every documented comparison marker. Each takes an ordered
 * {A, B} pair and yields a surface query whose decomposition MUST be [A, B].
 * English markers: vs / vs. / versus / compare…and / compare…with.
 * Korean markers: 와/과 + 비교, 랑 + 중에…좋아, 또는 + 어느.
 */
const ENGLISH_MARKER_BUILDERS: ReadonlyArray<(a: string, b: string) => string> = [
  (a, b) => `${a} vs ${b}`,
  (a, b) => `${a} vs. ${b}`,
  (a, b) => `${a} versus ${b}`,
  (a, b) => `compare ${a} and ${b}`,
  (a, b) => `compare ${a} with ${b}`,
];

const KOREAN_MARKER_BUILDERS: ReadonlyArray<(a: string, b: string) => string> = [
  (a, b) => `${a}와 ${b} 비교`,
  (a, b) => `${a}과 ${b} 비교`,
  (a, b) => `${a}랑 ${b} 중에 뭐가 좋아`,
  (a, b) => `${a} 또는 ${b} 어느`,
];

const ALL_MARKER_BUILDERS = [...ENGLISH_MARKER_BUILDERS, ...KOREAN_MARKER_BUILDERS];

/** Korean conjunctive particles, exercised individually for robustness. */
const KOREAN_PARTICLES: readonly string[] = ['와', '과', '이랑', '랑', '하고'] as const;

const entityArb = fc.constantFrom(...COMPARISON_ENTITIES);
const markerArb = fc.constantFrom(...ALL_MARKER_BUILDERS);

/** A distinct ordered pair (A !== B) drawn from the entity fixture set. */
const distinctPairArb = fc
  .tuple(entityArb, entityArb)
  .filter(([a, b]) => a !== b);

describe('decomposition-detection properties :: comparison marker exhaustiveness', () => {
  it('any {A,B} pair under any documented marker → decomposes to exactly [A, B]', () => {
    fc.assert(
      fc.property(distinctPairArb, markerArb, ([a, b], build) => {
        const query = build(a, b);
        const result = detectDecomposition(query);
        expect(result.decomposed).toBe(true);
        if (result.decomposed) {
          expect(result.subQueries[0]).toBe(a);
          expect(result.subQueries[1]).toBe(b);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('English markers and Korean markers BOTH decompose the same pair', () => {
    fc.assert(
      fc.property(distinctPairArb, ([a, b]) => {
        for (const build of ENGLISH_MARKER_BUILDERS) {
          expect(detectDecomposition(build(a, b)).decomposed).toBe(true);
        }
        for (const build of KOREAN_MARKER_BUILDERS) {
          expect(detectDecomposition(build(a, b)).decomposed).toBe(true);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: leg query non-empty', () => {
  it('when decomposed, BOTH legs (subQueries + comparisonLegs.rawQuery) are non-empty', () => {
    fc.assert(
      fc.property(distinctPairArb, markerArb, ([a, b], build) => {
        const result = detectDecomposition(build(a, b));
        expect(result.decomposed).toBe(true);
        if (result.decomposed) {
          expect(result.subQueries[0].trim().length).toBeGreaterThan(0);
          expect(result.subQueries[1].trim().length).toBeGreaterThan(0);
          expect(result.comparisonLegs[0].rawQuery.trim().length).toBeGreaterThan(0);
          expect(result.comparisonLegs[1].rawQuery.trim().length).toBeGreaterThan(0);
          // retrievalQuery is always derived and must also be non-empty.
          expect(result.comparisonLegs[0].retrievalQuery.trim().length).toBeGreaterThan(0);
          expect(result.comparisonLegs[1].retrievalQuery.trim().length).toBeGreaterThan(0);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: determinism', () => {
  it('same query 5x → identical decomposition outcome', () => {
    fc.assert(
      fc.property(distinctPairArb, markerArb, ([a, b], build) => {
        const query = build(a, b);
        const first = detectDecomposition(query);
        for (let i = 0; i < 4; i += 1) {
          expect(detectDecomposition(query)).toEqual(first);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: Korean particle robustness', () => {
  it('every conjunctive particle (와/과/이랑/랑/하고) + 비교 cue → consistent [A, B]', () => {
    const particleArb = fc.constantFrom(...KOREAN_PARTICLES);
    fc.assert(
      fc.property(distinctPairArb, particleArb, ([a, b], particle) => {
        // Particle attaches to A; downstream cue word "비교" anchors the match.
        const query = `${a}${particle} ${b} 비교`;
        const result = detectDecomposition(query);
        expect(result.decomposed).toBe(true);
        if (result.decomposed) {
          expect(result.subQueries[0]).toBe(a);
          expect(result.subQueries[1]).toBe(b);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: 3-way → pairwise scope', () => {
  it('"A vs B vs C" → first pair [A, "B vs C"] (documented pairwise boundary)', () => {
    // The detector is intentionally pairwise: the non-greedy left capture stops
    // at the FIRST marker, so the right leg retains the remaining "B vs C". This
    // property pins that boundary across arbitrary distinct triples so a
    // regression to e.g. ["A vs B", "C"] is caught.
    const tripleArb = fc
      .tuple(entityArb, entityArb, entityArb)
      .filter(([a, b, c]) => a !== b && b !== c && a !== c);
    fc.assert(
      fc.property(tripleArb, ([a, b, c]) => {
        const result = detectDecomposition(`${a} vs ${b} vs ${c}`);
        expect(result.decomposed).toBe(true);
        if (result.decomposed) {
          expect(result.subQueries[0]).toBe(a);
          expect(result.subQueries[1]).toBe(`${b} vs ${c}`);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: false-positive guard (MANDATORY)', () => {
  /**
   * Prosaic Korean queries: a conjunctive particle used as "with" (food pairing,
   * accompaniment) followed by a NON-cue tail. These MUST NOT decompose because
   * the Korean patterns require a downstream cue (중/비교/뭐가/어떤/차이/어느).
   * The tail vocabulary deliberately contains NO cue word.
   */
  it('Korean particle + non-cue prose tail → NOT decomposed', () => {
    const noiseTailArb = fc.constantFrom(
      '함께 마실 음식',
      '같이 먹을 치즈',
      '추천해줘',
      '안주로 좋은 메뉴',
      '와인 한 잔',
    );
    const particleArb = fc.constantFrom(...KOREAN_PARTICLES);
    fc.assert(
      fc.property(entityArb, particleArb, noiseTailArb, (a, particle, tail) => {
        const query = `${a}${particle} ${tail}`;
        expect(detectDecomposition(query).decomposed).toBe(false);
      }),
      { numRuns: FC_RUNS },
    );
  });

  /**
   * English prose containing "compared to" / "or" WITHOUT a comparison cue.
   * "compared to" is passive-voice (out of scope), and bare "or" lacks the
   * required which/better/choice cue. Neither must decompose.
   */
  it('English connector-word prose without a cue → NOT decomposed', () => {
    const proseArb = fc.constantFrom(
      'compared to last year prices rose',
      'compared to the 2010 vintage',
      'red or white wine please',
      'sparkling or still for the party',
      'tannic compared to most',
    );
    fc.assert(
      fc.property(proseArb, (query) => {
        expect(detectDecomposition(query).decomposed).toBe(false);
      }),
      { numRuns: FC_RUNS },
    );
  });

  /**
   * Single-entity / non-comparison queries with arbitrary trailing noise tokens.
   * No marker present → never decompose. The noise tokens are constrained to a
   * vocabulary free of any comparison marker substring.
   */
  it('single-entity query + arbitrary non-marker noise → NOT decomposed', () => {
    const noiseTokenArb = fc.constantFrom(
      'under',
      '20',
      'dollars',
      'red',
      'dry',
      '추천',
      '와인',
      'please',
    );
    fc.assert(
      fc.property(
        entityArb,
        fc.array(noiseTokenArb, { minLength: 0, maxLength: 4 }),
        (a, noise) => {
          const query = [a, ...noise].join(' ');
          expect(detectDecomposition(query).decomposed).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

describe('decomposition-detection properties :: specific edge cases', () => {
  it('special chars in entity: "Château d\'Yquem vs Sauternes" preserved in legs', () => {
    const result = detectDecomposition("Château d'Yquem vs Sauternes");
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[0]).toBe("Château d'Yquem");
      expect(result.subQueries[1]).toBe('Sauternes');
      expect(result.comparisonLegs[0].rawQuery).toBe("Château d'Yquem");
    }
  });

  it('NFC and NFD Korean comparison both decompose; legs equal under NFC normalization', () => {
    const base = '보르도 vs 부르고뉴';
    const nfc = base.normalize('NFC');
    const nfd = base.normalize('NFD');
    const rc = detectDecomposition(nfc);
    const rd = detectDecomposition(nfd);
    expect(rc.decomposed).toBe(true);
    expect(rd.decomposed).toBe(true);
    if (rc.decomposed && rd.decomposed) {
      // NFC form splits to the canonical region aliases verbatim.
      expect(rc.subQueries[0]).toBe('보르도');
      expect(rc.subQueries[1]).toBe('부르고뉴');
      // NFD form preserves decomposed jamo in the raw legs, but the legs
      // normalize back to the same canonical surfaces — detection is
      // normalization-form-robust.
      expect(rd.subQueries[0].normalize('NFC')).toBe('보르도');
      expect(rd.subQueries[1].normalize('NFC')).toBe('부르고뉴');
    }
  });
});
