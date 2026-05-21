/**
 * Property-based regression tests for nlu.relative-query-extractor (SOTA++ /
 * maturity 5 push).
 *
 * The enumerated regression suite (`relative-query-extractor.regression.test.ts`)
 * pins HAND-PICKED cases for each operator. This file complements it with
 * fast-check property invariants (numRuns: 100) that hold ACROSS the entire
 * generated space of Korean + English anchors, comparative tokens, and
 * intensifiers — not just the curated examples.
 *
 * Properties covered:
 *
 *   P1. Determinism — a fixed query yields the exact same extraction across
 *       repeated calls (regex-statefulness audit; `lastIndex` leak detector).
 *
 *   P2. Anchor preservation — for any generated `<anchor> <comparative>`
 *       query that produces an extraction, the trimmed/NFC-normalised anchor
 *       substring MUST appear in the extracted `anchorSurfaceForm`. This is
 *       the load-bearing invariant for downstream entity resolution.
 *
 *   P3. Korean comparative tokens (`보다 더`, `보다 덜`, `비슷한`, `같은`,
 *       `처럼`, `같이`) are recognised as canonical operators on a generated
 *       anchor — i.e. the extractor never silently drops these tokens.
 *
 *   P4. NFC stability — feeding the same logical query in NFC vs NFD form
 *       yields an extraction whose `anchorSurfaceForm` is NFC-stable
 *       (idempotent under `.normalize('NFC')`). This locks Unicode hygiene
 *       on the OUTPUT, independent of caller input form.
 *
 *   P5. Empty / whitespace-only input safety — empty string, whitespace-only,
 *       and pure-noise queries MUST return `null` (typed empty result), MUST
 *       NOT throw, and MUST NOT fabricate an anchor.
 *
 *   P6. Bounded output — `relativeExpressions.length` is bounded by the
 *       named SSoT constant `MAX_RELATIVE_EXPRESSIONS` for every input,
 *       including adversarial / repeated-marker inputs.
 *
 *   P7. Delta sign contract — for every produced expression that carries a
 *       `delta`, the value is finite, lies in `[-1, 1]`, and matches the
 *       operator's documented sign (less/cheaper/lighter/drier → ≤ 0;
 *       more/sweeter/fuller → ≥ 0; similar_to → exactly 0). No silent
 *       sign-flip is ever produced.
 *
 *   P8. Intensifier promotion — when `much` / `훨씬` is added to a "less" or
 *       "more" operator query, the resolved delta MUST be either the regular
 *       tier (`±0.2`) or the much tier (`±0.5`); never an unrelated value
 *       and never with a flipped sign.
 *
 *   P9. No `\b` on non-ASCII inputs (regex hygiene audit) — extraction on
 *       random Korean-only inputs MUST NOT throw and MUST NOT produce
 *       garbage anchors (e.g. anchors that contain the comparative token
 *       itself). This is a structural guard against `\b` boundary regressions
 *       per CLAUDE.md test discipline rule 8.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify the source
 * extractor beyond NFC normalisation of the anchor surface form and a new
 * named bound constant — both of which are SOTA++ hygiene fixes, not
 * heuristics.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RelativeQueryExtractor,
  RELATIVE_DELTA_LESS,
  RELATIVE_DELTA_MORE,
  RELATIVE_DELTA_MUCH_LESS,
  RELATIVE_DELTA_MUCH_MORE,
  RELATIVE_DELTA_SIMILAR,
  MAX_RELATIVE_EXPRESSIONS,
} from '../../src/domain/query/service/relative-query-extractor.js';
import type { RelativeOperator } from '../../src/domain/query/model/relative-query.js';

const RUNS = 100;

// ─── Generators ───────────────────────────────────────────────────────────────

// Anchor surface generator: Korean + English wine-like names. Constrained to
// letters/spaces so generated anchors cannot themselves contain a comparative
// marker (`보다`, `같은`, etc.), which would muddy P2/P3 assertions.
const anchorSurface = fc.constantFrom(
  'Opus One',
  'Sassicaia',
  'Chateau Margaux',
  'Barolo',
  'Bordeaux',
  '오퍼스 원',
  '오푸스 원',
  '샤토 마고',
  '바롤로',
  '돔 페리뇽',
);

// Operators with a definite NEGATIVE delta sign contract.
const NEGATIVE_OPERATORS: ReadonlySet<RelativeOperator> = new Set<RelativeOperator>([
  'cheaper_than',
  'lighter_than',
  'drier_than',
  'less_tannic_than',
  'less_fruity_than',
]);

// Operators with a definite POSITIVE delta sign contract.
const POSITIVE_OPERATORS: ReadonlySet<RelativeOperator> = new Set<RelativeOperator>([
  'more_expensive_than',
  'fuller_than',
  'sweeter_than',
  'more_tannic_than',
  'more_fruity_than',
]);

// Korean comparative surface frames, parameterised by `<anchor>`. Each entry
// MUST yield a non-null extraction when concatenated with a generated anchor.
interface KoreanFrame {
  readonly tail: string;
  readonly expected: RelativeOperator;
}
const KOREAN_FRAMES: readonly KoreanFrame[] = [
  { tail: '보다 더 떫은', expected: 'more_tannic_than' },
  { tail: '보다 덜 떫은', expected: 'less_tannic_than' },
  { tail: '보다 더 과실향', expected: 'more_fruity_than' },
  { tail: '보다 덜 과실향', expected: 'less_fruity_than' },
  { tail: '보다 저렴한', expected: 'cheaper_than' },
  { tail: '보다 비싼', expected: 'more_expensive_than' },
  { tail: '보다 가벼운', expected: 'lighter_than' },
  { tail: '보다 묵직한', expected: 'fuller_than' },
  { tail: '보다 드라이한', expected: 'drier_than' },
  { tail: '보다 달달한', expected: 'sweeter_than' },
  { tail: ' 같은', expected: 'similar_to' },
  { tail: ' 비슷한', expected: 'similar_to' },
  { tail: ' 처럼', expected: 'similar_to' },
  { tail: ' 같이', expected: 'similar_to' },
];

const koreanFrame = fc.constantFrom(...KOREAN_FRAMES);

const extractor = new RelativeQueryExtractor();

// ─── Property suite ──────────────────────────────────────────────────────────

describe('relative-query-extractor — properties (regression, SOTA++)', () => {
  // P1. Determinism ──────────────────────────────────────────────────────────
  it('P1: extraction is deterministic across 5 evaluations of the same query', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            'less tannic than Opus One',
            'cheaper than Sassicaia',
            '오퍼스 원보다 비싼',
            '오퍼스 원 같은 와인',
            'much more fruity than Opus One',
            '',
            '   ',
            'no anchor here',
          ),
          fc.string({ maxLength: 60 }),
        ),
        (query) => {
          const runs = Array.from({ length: 5 }, () => extractor.extract(query));
          const first = runs[0];
          for (const r of runs) {
            expect(r).toEqual(first);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P2. Anchor preservation (Korean 보다 frames) ────────────────────────────
  it('P2: any Korean "<anchor>보다 <op>" query preserves the anchor surface', () => {
    fc.assert(
      fc.property(anchorSurface, koreanFrame, (anchor, frame) => {
        // skip similarity frames here — they use a different shape
        fc.pre(frame.tail.startsWith('보다'));
        const query = `${anchor}${frame.tail}`;
        const result = extractor.extract(query);
        expect(result).not.toBeNull();
        const expr = result?.relativeExpressions[0];
        expect(expr).toBeDefined();
        // The extracted anchor surface MUST contain the generated anchor (after
        // trim/NFC) — this is the load-bearing invariant for downstream entity
        // resolution.
        expect(expr?.anchorSurfaceForm).toBe(anchor.normalize('NFC'));
        expect(expr?.operator).toBe(frame.expected);
      }),
      { numRuns: RUNS },
    );
  });

  // P2b. Anchor preservation (Korean similarity frames) ─────────────────────
  it('P2b: Korean "<anchor> <similarity>" query preserves anchor + flags similarity', () => {
    fc.assert(
      fc.property(
        anchorSurface,
        fc.constantFrom('같은', '비슷한', '처럼', '같이'),
        (anchor, marker) => {
          const query = `${anchor} ${marker}`;
          const result = extractor.extract(query);
          expect(result).not.toBeNull();
          expect(result?.isSimilarityQuery).toBe(true);
          const expr = result?.relativeExpressions[0];
          expect(expr?.operator).toBe('similar_to');
          expect(expr?.anchorSurfaceForm).toBe(anchor.normalize('NFC'));
          expect(expr?.delta).toBe(RELATIVE_DELTA_SIMILAR);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P2c. Anchor preservation (English postfix frames) ───────────────────────
  it('P2c: English "<op> than <anchor>" query preserves anchor', () => {
    fc.assert(
      fc.property(
        anchorSurface,
        fc.constantFrom(
          'less tannic than',
          'more tannic than',
          'cheaper than',
          'more expensive than',
          'lighter than',
          'heavier than',
          'drier than',
          'sweeter than',
          'less fruity than',
          'more fruity than',
        ),
        (anchor, op) => {
          const query = `${op} ${anchor}`;
          const result = extractor.extract(query);
          expect(result).not.toBeNull();
          const expr = result?.relativeExpressions[0];
          expect(expr).toBeDefined();
          // Extracted anchor must include the generated anchor token.
          expect(expr?.anchorSurfaceForm).toContain(anchor);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P3. Korean comparative tokens recognised canonically ────────────────────
  it('P3: every Korean comparative frame yields the documented operator', () => {
    fc.assert(
      fc.property(anchorSurface, koreanFrame, (anchor, frame) => {
        const tail = frame.tail.startsWith('보다') ? frame.tail : frame.tail;
        const query = `${anchor}${tail}`;
        const result = extractor.extract(query);
        expect(result).not.toBeNull();
        expect(result?.relativeExpressions[0]?.operator).toBe(frame.expected);
      }),
      { numRuns: RUNS },
    );
  });

  // P4. NFC stability ──────────────────────────────────────────────────────
  it('P4: extracted anchorSurfaceForm is NFC-idempotent (NFC(extracted) === extracted)', () => {
    fc.assert(
      fc.property(anchorSurface, koreanFrame, (anchor, frame) => {
        const tail = frame.tail;
        const query = `${anchor}${tail}`;
        // Also test with NFD-decomposed input — output must still be NFC.
        const nfdQuery = query.normalize('NFD');
        const r1 = extractor.extract(query);
        const r2 = extractor.extract(nfdQuery);
        for (const r of [r1, r2]) {
          if (r === null) continue;
          for (const e of r.relativeExpressions) {
            expect(e.anchorSurfaceForm).toBe(e.anchorSurfaceForm.normalize('NFC'));
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  // P5. Empty / whitespace-only safety ──────────────────────────────────────
  it('P5: empty / whitespace-only / pure-noise input → null, no throw', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('', ' ', '\t', '\n', '   ', '　　'),
          // Pure-noise: digits and punctuation only — no anchor, no marker.
          fc.stringMatching(/^[-0-9.,;:!?@#$%^&*()_+=[\]{}/\\<>~`'"]*$/).map(
            (s) => s.slice(0, 60),
          ),
        ),
        (query) => {
          let result;
          expect(() => {
            result = extractor.extract(query);
          }).not.toThrow();
          expect(result).toBeNull();
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P6. Bounded output ──────────────────────────────────────────────────────
  it('P6: relativeExpressions.length ≤ MAX_RELATIVE_EXPRESSIONS for any input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            'less tannic but more fruity than Opus One',
            '오퍼스 원보다 덜 떫은 더 과실향 같은 비슷한',
            'cheaper than Opus One similar to Sassicaia',
            // adversarial: every operator surface stuffed together.
            'less tannic than X more tannic than Y cheaper than Z lighter than W',
          ),
          fc.string({ maxLength: 200 }),
        ),
        (query) => {
          const result = extractor.extract(query);
          if (result === null) return;
          expect(result.relativeExpressions.length).toBeLessThanOrEqual(
            MAX_RELATIVE_EXPRESSIONS,
          );
          expect(result.relativeExpressions.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P7. Delta sign contract ─────────────────────────────────────────────────
  it('P7: every emitted delta is finite, in [-1, 1], and sign-correct per operator', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            'less tannic than Opus One',
            'more tannic than Opus One',
            'cheaper than Opus One',
            'more expensive than Opus One',
            'lighter than Opus One',
            'heavier than Opus One',
            'drier than Opus One',
            'sweeter than Opus One',
            'less fruity than Opus One',
            'more fruity than Opus One',
            '오퍼스 원처럼',
            'similar to Opus One',
          ),
          fc.string({ maxLength: 60 }),
        ),
        (query) => {
          const result = extractor.extract(query);
          if (result === null) return;
          for (const e of result.relativeExpressions) {
            if (e.delta === undefined) continue;
            expect(Number.isFinite(e.delta)).toBe(true);
            expect(e.delta).toBeGreaterThanOrEqual(-1);
            expect(e.delta).toBeLessThanOrEqual(1);
            if (NEGATIVE_OPERATORS.has(e.operator)) {
              expect(e.delta).toBeLessThanOrEqual(0);
            } else if (POSITIVE_OPERATORS.has(e.operator)) {
              expect(e.delta).toBeGreaterThanOrEqual(0);
            } else if (e.operator === 'similar_to') {
              expect(e.delta).toBe(RELATIVE_DELTA_SIMILAR);
            }
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P8. Intensifier promotion ──────────────────────────────────────────────
  it('P8: intensifier promotes delta to ±0.5 tier without sign-flip', () => {
    const ALLOWED_DELTAS = new Set<number>([
      RELATIVE_DELTA_LESS,
      RELATIVE_DELTA_MORE,
      RELATIVE_DELTA_MUCH_LESS,
      RELATIVE_DELTA_MUCH_MORE,
      RELATIVE_DELTA_SIMILAR,
    ]);
    fc.assert(
      fc.property(
        anchorSurface,
        fc.constantFrom('much', 'way', '훨씬', '한참'),
        fc.constantFrom(
          { en: 'less tannic than', expected: RELATIVE_DELTA_MUCH_LESS },
          { en: 'more tannic than', expected: RELATIVE_DELTA_MUCH_MORE },
          { en: 'cheaper than', expected: RELATIVE_DELTA_MUCH_LESS },
          { en: 'more expensive than', expected: RELATIVE_DELTA_MUCH_MORE },
        ),
        (anchor, intensifier, op) => {
          // English form: "<intensifier> <op> <anchor>"
          // Korean intensifiers (훨씬/한참) still placed in front to test the
          // intensifier-detection regex independent of anchor language.
          const query = `${intensifier} ${op.en} ${anchor}`;
          const result = extractor.extract(query);
          expect(result).not.toBeNull();
          const expr = result?.relativeExpressions[0];
          expect(expr).toBeDefined();
          expect(expr?.delta).toBeDefined();
          if (expr?.delta !== undefined) {
            expect(ALLOWED_DELTAS.has(expr.delta)).toBe(true);
            // Promoted value must match the expected MUCH-tier sign.
            expect(expr.delta).toBe(op.expected);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // P9. Regex hygiene — Korean-only random input never crashes ─────────────
  it('P9: random Korean syllable strings never throw and never fabricate marker-substring anchors', () => {
    // Korean syllable range U+AC00 .. U+D7A3 (Hangul Syllables block).
    const koreanChar = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));
    const koreanString = fc.array(koreanChar, { minLength: 0, maxLength: 12 }).map((a) => a.join(''));
    fc.assert(
      fc.property(koreanString, (query) => {
        let result;
        expect(() => {
          result = extractor.extract(query);
        }).not.toThrow();
        // If an extraction is produced, the anchor surface must not itself
        // contain the comparative token (`보다`) — that would be a regex
        // boundary leak (anchor capture group eating the marker).
        if (result !== null && result !== undefined) {
          const r = result as { relativeExpressions: ReadonlyArray<{ anchorSurfaceForm: string }> };
          for (const e of r.relativeExpressions) {
            expect(e.anchorSurfaceForm.includes('보다 ')).toBe(false);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  // P10. MAX_RELATIVE_EXPRESSIONS is a positive integer ─────────────────────
  it('P10: MAX_RELATIVE_EXPRESSIONS is a positive integer (named SSoT bound)', () => {
    expect(Number.isInteger(MAX_RELATIVE_EXPRESSIONS)).toBe(true);
    expect(MAX_RELATIVE_EXPRESSIONS).toBeGreaterThan(0);
  });
});
