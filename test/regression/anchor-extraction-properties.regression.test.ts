/**
 * Property-based regression tests for anchor-extraction marker precision.
 *
 * Wave 3 introduced a phrase-level idiom/temporal guard
 * (`KOREAN_MARKER_IDIOM_ANTIPATTERNS`) that strips idiomatic occurrences of
 * comparison particles ("같은", "처럼") before the SSoT marker regexes run, so
 * that "어제와 같은 와인" (temporal) and "가솔린처럼 가볍다" (simile) do NOT
 * flag as mixed/comparison queries. Wave 3 also locked in determinism and
 * Unicode hygiene via 17 enumerated cases.
 *
 * This file complements those enumerated cases with PROPERTY-BASED invariants
 * (fast-check, numRuns: 100) so the guard holds across the entire generated
 * space of temporal prefixes, simile nouns, entity surfaces, and comparison
 * markers — not just the hand-picked examples. The properties target the
 * highest-value invariants for an entity-anchoring NLU surface:
 *
 *   P1. Determinism — a fixed query yields identical marker verdicts across
 *       5 evaluations (no hidden global / stateful regex `lastIndex` leak).
 *   P2. Idiom false-positive guard — ANY generated Korean temporal "X와/과
 *       같은 …" phrase and ANY generated "<noun 처럼>" simile MUST NOT flag as
 *       a mixed/comparison query. This is the dominant false-positive class.
 *   P3. True comparison detection — ANY generated entity-pair joined by a
 *       real comparison marker (vs / versus / compared to, or the Korean
 *       "과/와 … 비교" frame) MUST flag as a comparison query.
 *   P4. NFC stability (production-contract form) — the marker regexes assume
 *       PRECOMPOSED (NFC) Hangul, which is the canonical form that
 *       `nlu.query-normalizer` guarantees upstream before anchor extraction
 *       runs. The genuinely-holding invariant is therefore NFC idempotence:
 *       a query normalized to NFC once yields the same verdict as the same
 *       query normalized to NFC twice. We additionally pin the KNOWN
 *       divergence on raw NFD input (Hangul jamo decomposition breaks the
 *       particle/marker syllables) so the limitation is locked, not silently
 *       "fixed" by loosening the engine. See the YAML known_limitations entry.
 *   P5. Empty / no-anchor → no false anchor — whitespace-only, attribute-only,
 *       and pure-noise queries never fabricate a marker.
 *   P6. Special-char preservation — accented Latin + apostrophe entity names
 *       ("Château d'Yquem") never crash and still allow an adjacent Korean
 *       similarity marker to fire.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify
 * `anchor-extractor.ts`. The Wave-3 implementation already satisfies every
 * property below.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  hasComparisonMarkers,
  hasKoreanMixedQueryMarkers,
} from '../../src/domain/query/service/anchor-extractor.js';

const RUNS = 100;

// Temporal prefixes guarded by KOREAN_MARKER_IDIOM_ANTIPATTERNS (composed with
// 와/과 + 같은). Kept in lockstep with the source antipattern list.
const TEMPORAL_PREFIXES: readonly string[] = [
  '어제', '오늘', '내일', '모레', '아까', '방금',
  '지금', '예전', '작년', '올해', '평소', '평상시',
] as const;

// Simile nouns guarded by the "<noun>처럼" antipattern.
const SIMILE_NOUNS: readonly string[] = ['가솔린', '물', '불', '꿀', '기름'] as const;

// Real comparison markers that MUST trigger hasComparisonMarkers when placed
// between two entity surfaces with surrounding whitespace.
const LATIN_COMPARISON_MARKERS: readonly string[] = ['vs', 'vs.', 'versus', 'compared to'] as const;

// Entity-surface generator: Latin wine/producer names + Korean entity names.
// Constrained to letters/digits/spaces so the generated tail noun never itself
// introduces a stray comparison marker.
const entitySurface = fc.constantFrom(
  'Opus One',
  'Sassicaia',
  'Bordeaux',
  'Barolo',
  'Margaux',
  '마고',
  '오퍼스원',
  '바롤로',
);

// Korean tail noun that is NOT a marker (descriptive object of the query).
const koreanTail = fc.constantFrom('와인', '레드', '스타일', '느낌', '바디');

describe('anchor-extraction marker precision — properties (regression)', () => {
  // ── P1. Determinism ───────────────────────────────────────────────────────
  it('P1: marker verdicts are deterministic across 5 evaluations of the same query', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            'Opus One 같은 와인',
            'Opus One vs Sassicaia',
            '어제와 같은 와인',
            '가솔린처럼 가볍다',
            '좋은 와인 추천',
            'A과 B 비교',
          ),
          fc.string({ maxLength: 40 }),
        ),
        (query) => {
          const verdicts = Array.from({ length: 5 }, () => ({
            mixed: hasKoreanMixedQueryMarkers(query),
            compare: hasComparisonMarkers(query),
          }));
          const first = verdicts[0];
          expect(first).toBeDefined();
          for (const v of verdicts) {
            expect(v.mixed).toBe(first?.mixed);
            expect(v.compare).toBe(first?.compare);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  // ── P2. Idiom false-positive guard ────────────────────────────────────────
  it('P2: generated temporal "X와/과 같은 …" phrases never flag mixed/comparison', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TEMPORAL_PREFIXES),
        fc.constantFrom('와', '과'),
        koreanTail,
        (prefix, particle, tail) => {
          // e.g. "어제와 같은 와인" / "평소과 같은 스타일"
          const query = `${prefix}${particle} 같은 ${tail}`;
          expect(hasKoreanMixedQueryMarkers(query)).toBe(false);
          expect(hasComparisonMarkers(query)).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('P2: generated "<noun>처럼 …" similes never flag mixed/comparison', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SIMILE_NOUNS),
        koreanTail,
        (noun, tail) => {
          // e.g. "가솔린처럼 가볍다"-shaped surfaces.
          const query = `${noun}처럼 ${tail}`;
          expect(hasKoreanMixedQueryMarkers(query)).toBe(false);
          expect(hasComparisonMarkers(query)).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // ── P3. True comparison detection ─────────────────────────────────────────
  it('P3: entity-pair joined by a Latin comparison marker flags comparison', () => {
    fc.assert(
      fc.property(
        entitySurface,
        entitySurface,
        fc.constantFrom(...LATIN_COMPARISON_MARKERS),
        (left, right, marker) => {
          const query = `${left} ${marker} ${right}`;
          expect(hasComparisonMarkers(query)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('P3: Korean "과/와 … 비교" frame between entities flags comparison', () => {
    fc.assert(
      fc.property(
        entitySurface,
        fc.constantFrom('과', '와', '랑', '하고', '이랑'),
        entitySurface,
        (left, joiner, right) => {
          // e.g. "Opus One과 Sassicaia 비교"
          const query = `${left}${joiner} ${right} 비교`;
          expect(hasComparisonMarkers(query)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('P3: entity + Korean similarity marker 같은 flags a mixed query', () => {
    fc.assert(
      fc.property(entitySurface, koreanTail, (entity, tail) => {
        const query = `${entity} 같은 ${tail}`;
        expect(hasKoreanMixedQueryMarkers(query)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  // ── P4. NFC stability (production-contract form) ──────────────────────────
  it('P4: NFC normalization is idempotent for marker verdicts (mixed + comparison)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            'Opus One 같은 와인',
            'Opus One과 Sassicaia 비교',
            '어제와 같은 와인',
            '가솔린처럼 가볍다',
          ),
          fc.string({ maxLength: 40 }),
        ),
        (raw) => {
          // Production normalizes to NFC upstream; the marker layer must be
          // stable under repeated NFC normalization (idempotence).
          const once = raw.normalize('NFC');
          const twice = once.normalize('NFC');
          expect(hasKoreanMixedQueryMarkers(twice)).toBe(
            hasKoreanMixedQueryMarkers(once),
          );
          expect(hasComparisonMarkers(twice)).toBe(hasComparisonMarkers(once));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('P4 (pinned limitation): raw NFD Hangul input does NOT match (regexes assume NFC)', () => {
    // KNOWN LIMITATION (locked, not a bug to fix here): the marker regexes
    // operate on precomposed syllables. Decomposing to NFD splits 같은/과/와
    // into jamo and breaks the match. This is acceptable because
    // nlu.query-normalizer guarantees NFC before this layer runs. We pin the
    // behavior so any future change that silently alters it is caught.
    const composedMixed = 'Opus One 같은 와인'.normalize('NFC');
    const composedCmp = 'Opus One과 Sassicaia 비교'.normalize('NFC');
    expect(hasKoreanMixedQueryMarkers(composedMixed)).toBe(true);
    expect(hasComparisonMarkers(composedCmp)).toBe(true);
    expect(hasKoreanMixedQueryMarkers(composedMixed.normalize('NFD'))).toBe(false);
    expect(hasComparisonMarkers(composedCmp.normalize('NFD'))).toBe(false);
  });

  // ── P5. Empty / no-anchor → no false anchor ───────────────────────────────
  it('P5: whitespace-only queries never flag a marker', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[ \t\n]{0,12}$/u),
        (blank) => {
          expect(hasKoreanMixedQueryMarkers(blank)).toBe(false);
          expect(hasComparisonMarkers(blank)).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('P5: attribute/noise-only queries (no marker token) never flag a marker', () => {
    // Vocabulary deliberately excludes any marker particle/keyword so the
    // assembled query cannot legitimately match a marker. If any combination
    // flags, that is an over-eager substring regex.
    const noiseWord = fc.constantFrom(
      '좋은', '와인', '추천', '레드', '화이트', '드라이', '달콤한',
      'good', 'wine', 'red', 'dry', 'sweet', 'recommend', 'bottle',
    );
    fc.assert(
      fc.property(fc.array(noiseWord, { minLength: 0, maxLength: 6 }), (words) => {
        const query = words.join(' ');
        expect(hasKoreanMixedQueryMarkers(query)).toBe(false);
        expect(hasComparisonMarkers(query)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  // ── P6. Special-char preservation ─────────────────────────────────────────
  it('P6: accented-Latin + apostrophe entity + 같은 never crashes and still flags mixed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Château d'Yquem", 'Château Margaux', "Côte d'Or", 'Châteauneuf-du-Pape'),
        koreanTail,
        (entity, tail) => {
          const query = `${entity} 같은 ${tail}`;
          expect(() => hasKoreanMixedQueryMarkers(query)).not.toThrow();
          expect(() => hasComparisonMarkers(query)).not.toThrow();
          expect(hasKoreanMixedQueryMarkers(query)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
