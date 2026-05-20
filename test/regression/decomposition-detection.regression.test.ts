/**
 * Regression: nlu.decomposition-detection
 *
 * Locks the surface contract of `detectDecomposition` / `analyzeQueryDecomposition`
 * across English + Korean comparison patterns, subtype classification, negative
 * (false-positive) cases, and implicit comparative boundaries. The detector is
 * deliberately surface-pattern based (see decomposition-detector.ts header) —
 * this suite is the canonical record of what the runtime DOES detect today and
 * what it intentionally does NOT.
 *
 * Append-only: do not delete cases. If detector behavior must change,
 * update the test and document the boundary shift in the feature catalog
 * YAML rationale at tools/feature-catalog/features/nlu/decomposition-detection.yaml.
 */

import { describe, it, expect } from 'vitest';
import {
  detectDecomposition,
  analyzeQueryDecomposition,
} from '../../src/domain/query/service/decomposition-detector.js';

describe('decomposition-detection regression :: English comparison patterns', () => {
  it('"X vs Y" → decomposed concept comparison', () => {
    const result = detectDecomposition('Opus One vs Screaming Eagle');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
      expect(result.comparisonIntent).toBe('compare');
      expect(result.comparisonLegs[0].rawQuery).toBe('Opus One');
      expect(result.comparisonLegs[1].rawQuery).toBe('Screaming Eagle');
    }
  });

  it('"X versus Y" → decomposed', () => {
    const result = detectDecomposition('Opus One versus Screaming Eagle');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
    }
  });

  it('"compare X and Y" → decomposed (region contrast)', () => {
    const result = detectDecomposition('compare Bordeaux and Burgundy');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Bordeaux', 'Burgundy']);
      expect(result.comparisonSubtype).toBe('concept');
      expect(result.comparisonLegs[0].conceptEntityType).toBe('region');
      expect(result.comparisonLegs[1].conceptEntityType).toBe('region');
    }
  });

  it('"compare X with Y" → decomposed', () => {
    const result = detectDecomposition('compare Margaux with Pauillac');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Margaux', 'Pauillac']);
    }
  });

  it('"X or Y which is better" → decomposed with recommend_one intent', () => {
    const result = detectDecomposition('Opus One or Screaming Eagle which is better');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
      expect(result.comparisonIntent).toBe('recommend_one');
    }
  });

  it('boundary: "X compared to Y" → NOT decomposed (surface "compared to" pattern not supported)', () => {
    // Documented limitation: the detector matches the literal token "compare" /
    // "versus" / "vs" / "or … which|better|choice" — passive-voice "compared to"
    // is intentionally out of scope until a parse-based detector lands.
    const result = detectDecomposition('Bordeaux compared to Burgundy');
    expect(result.decomposed).toBe(false);
  });

  it('boundary: "between X and Y" → NOT decomposed (no "between" pattern)', () => {
    // Documented limitation: "between … and …" requires a cue word ("better",
    // "choice", "vs") to disambiguate from connective "and". Out of scope.
    const result = detectDecomposition('between Bordeaux and Burgundy');
    expect(result.decomposed).toBe(false);
  });
});

describe('decomposition-detection regression :: Korean comparison patterns', () => {
  it('"X와 Y 비교" → decomposed', () => {
    const result = detectDecomposition('Opus One와 Screaming Eagle 비교');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
      expect(result.comparisonIntent).toBe('compare');
    }
  });

  it('"X랑 Y 중에" → decomposed with recommend_one intent (어 … 좋아)', () => {
    const result = detectDecomposition('Opus One랑 Screaming Eagle 중에 뭐가 좋아');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
      expect(result.comparisonIntent).toBe('recommend_one');
    }
  });

  it('"X 또는 Y 어느" → decomposed (Korean disjunction pattern with terminal cue)', () => {
    const result = detectDecomposition('Opus One 또는 Screaming Eagle 어느');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Opus One', 'Screaming Eagle']);
    }
  });

  it('"X vs Y" mixed Korean-English → decomposed (Korean entities, English connective)', () => {
    const result = detectDecomposition('보르도 vs 부르고뉴');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['보르도', '부르고뉴']);
      expect(result.comparisonSubtype).toBe('concept');
      // Hangul region names resolve via alias → canonical EN region.
      expect(result.comparisonLegs[0].conceptEntityType).toBe('region');
      expect(result.comparisonLegs[1].conceptEntityType).toBe('region');
    }
  });

  it('Korean particle "과" variant ("X과 Y 비교") → decomposed', () => {
    const result = detectDecomposition('Bordeaux과 Burgundy 비교');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Bordeaux', 'Burgundy']);
    }
  });

  it('Korean particle "이랑" variant ("X이랑 Y 중에") → decomposed', () => {
    const result = detectDecomposition('Bordeaux이랑 Burgundy 중에');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Bordeaux', 'Burgundy']);
    }
  });

  it('Korean particle "하고" variant ("X하고 Y 차이") → decomposed', () => {
    const result = detectDecomposition('Bordeaux하고 Burgundy 차이');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries).toEqual(['Bordeaux', 'Burgundy']);
    }
  });
});

describe('decomposition-detection regression :: subtype classification', () => {
  it('entity_pair: 2 named wines without concept resolution → subtype "entity"', () => {
    // "expensive" / "affordable wines" do not resolve to any of the concept
    // entity types (wine_type/country/region/appellation/grape_primary), so
    // both legs fall through to the entity-default leg.
    const result = detectDecomposition('expensive vs affordable wines');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.comparisonSubtype).toBe('entity');
      expect(result.comparisonLegs[0].mode).toBe('entity');
      expect(result.comparisonLegs[1].mode).toBe('entity');
    }
  });

  it('region_contrast: "Bordeaux vs Burgundy" → subtype "concept" with region entity type', () => {
    const result = detectDecomposition('Bordeaux vs Burgundy');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.comparisonSubtype).toBe('concept');
      expect(result.comparisonLegs[0].canonicalConcept).toBe('Bordeaux');
      expect(result.comparisonLegs[0].conceptEntityType).toBe('region');
      expect(result.comparisonLegs[1].canonicalConcept).toBe('Burgundy');
      expect(result.comparisonLegs[1].conceptEntityType).toBe('region');
      expect(result.comparisonLegs[0].retrievalQuery).toBe('Bordeaux wine');
      expect(result.comparisonLegs[1].retrievalQuery).toBe('Burgundy wine');
    }
  });

  it('price_contrast: "expensive vs cheap wines" → no concept resolution, subtype "entity"', () => {
    // Price descriptors are not in the concept entity-type whitelist
    // (wine_type / country / region / appellation / grape_primary).
    // This documents that price-axis comparisons fall to entity legs,
    // not a dedicated price_contrast subtype.
    const result = detectDecomposition('expensive vs cheap wines');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.comparisonSubtype).toBe('entity');
    }
  });

  it('style_exploration: "dry vs sweet wines" → subtype "mixed" (sweet → dessert wine_type)', () => {
    // "sweet wines" resolves to wine_type=dessert via span resolution; "dry" does
    // not resolve. Result: one concept leg + one entity leg → mixed.
    const result = detectDecomposition('dry vs sweet wines');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.comparisonSubtype).toBe('mixed');
      const conceptLeg = result.comparisonLegs.find((l) => l.mode === 'concept');
      expect(conceptLeg).toBeDefined();
      expect(conceptLeg?.conceptEntityType).toBe('wine_type');
    }
  });
});

describe('decomposition-detection regression :: negative cases (no false-positive comparison)', () => {
  it('"와인 추천" → not decomposed (no comparison cue, no second wine)', () => {
    const result = detectDecomposition('와인 추천');
    expect(result.decomposed).toBe(false);
  });

  it('"Opus One와 함께 마실 음식" → not decomposed (와 as connector, not comparison)', () => {
    // The particle 와 here means "with" (food pairing), not "and (compare)".
    // The Korean patterns require a downstream cue word (중/비교/뭐가/어떤/차이/어느),
    // and "함께 마실 음식" does not contain one.
    const result = detectDecomposition('Opus One와 함께 마실 음식');
    expect(result.decomposed).toBe(false);
  });

  it('"compared to last year, prices rose" → not decomposed (no wine entities, no "vs" cue)', () => {
    // No "compare X and Y", no "X vs Y" pattern — just "compared to" prose.
    const result = detectDecomposition('compared to last year, prices rose');
    expect(result.decomposed).toBe(false);
  });

  it('"red wine under $20" → not decomposed', () => {
    const result = detectDecomposition('red wine under $20');
    expect(result.decomposed).toBe(false);
  });

  it('single entity with vintage → not decomposed', () => {
    const result = detectDecomposition('Chateau Lafite Rothschild 2015');
    expect(result.decomposed).toBe(false);
  });
});

describe('decomposition-detection regression :: implicit multi-way (audit gap)', () => {
  it('"wines like Opus One but cheaper" → NOT decomposed (documented limitation)', () => {
    // AUDIT GAP (recorded in feature-catalog YAML known_limitations):
    // Implicit comparative ("like X but cheaper", "similar to X but younger")
    // is NOT detected by the current surface-pattern matcher. It requires
    // dependency-parse or LLM-based intent classification.
    //
    // Surfacing this in a locked regression test ensures any future detector
    // that DOES support this case must update this test deliberately.
    const result = detectDecomposition('wines like Opus One but cheaper');
    expect(result.decomposed).toBe(false);
  });

  it('"something similar to Opus One but younger" → NOT decomposed (documented limitation)', () => {
    const result = detectDecomposition('something similar to Opus One but younger');
    expect(result.decomposed).toBe(false);
  });
});

describe('decomposition-detection regression :: adjacent edge cases', () => {
  it('empty query → not decomposed', () => {
    const result = detectDecomposition('');
    expect(result.decomposed).toBe(false);
  });

  it('whitespace-only query → not decomposed', () => {
    const result = detectDecomposition('   ');
    expect(result.decomposed).toBe(false);
  });

  it('"Château d\'Yquem vs Sauternes" → decomposed (special chars preserved in leg rawQuery)', () => {
    // Apostrophe and accented Latin must survive the regex split untouched.
    const result = detectDecomposition("Château d'Yquem vs Sauternes");
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[0]).toBe("Château d'Yquem");
      expect(result.subQueries[1]).toBe('Sauternes');
      expect(result.comparisonLegs[0].rawQuery).toBe("Château d'Yquem");
    }
  });

  it('3-way "X vs Y vs Z" → decomposes greedily to first pair, second leg keeps "Y vs Z" (documented boundary)', () => {
    // BOUNDARY: the regex is non-greedy on the left and matches up to the next
    // anchor on the right, so "A vs B vs C" → ["A", "B vs C"]. The detector is
    // intentionally pairwise; n-way comparison is out of scope and tracked as a
    // known limitation in the feature catalog YAML. This test pins the current
    // pairwise behavior so a regression to e.g. ["A vs B", "C"] is detectable.
    const result = detectDecomposition('Opus One vs Screaming Eagle vs Almaviva');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[0]).toBe('Opus One');
      expect(result.subQueries[1]).toBe('Screaming Eagle vs Almaviva');
    }
  });

  it('question mark terminator: "Opus One vs Screaming Eagle?" → strips ? from second leg', () => {
    const result = detectDecomposition('Opus One vs Screaming Eagle?');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[1]).toBe('Screaming Eagle');
    }
  });

  it('determinism: same input across 5 calls yields identical legs', () => {
    const q = 'Opus One vs Screaming Eagle';
    const first = detectDecomposition(q);
    expect(first.decomposed).toBe(true);
    for (let i = 0; i < 4; i++) {
      const next = detectDecomposition(q);
      expect(next).toEqual(first);
    }
  });

  it('determinism: Korean repeated calls yield identical legs', () => {
    const q = '보르도 vs 부르고뉴';
    const first = detectDecomposition(q);
    expect(first.decomposed).toBe(true);
    for (let i = 0; i < 4; i++) {
      const next = detectDecomposition(q);
      expect(next).toEqual(first);
    }
  });
});

describe('decomposition-detection regression :: analyzeQueryDecomposition hint surface', () => {
  it('decomposed query → hint.strategy="comparison", subQueryCount=2, confidence=0.9', () => {
    const analysis = analyzeQueryDecomposition('Opus One vs Screaming Eagle');
    expect(analysis.hint.strategy).toBe('comparison');
    expect(analysis.hint.subQueryCount).toBe(2);
    expect(analysis.hint.confidence).toBe(0.9);
    expect(analysis.hint.reason).toBe('comparison:compare');
  });

  it('non-decomposed query → hint.strategy="none", subQueryCount=0, confidence=0', () => {
    const analysis = analyzeQueryDecomposition('red wine under $20');
    expect(analysis.hint.strategy).toBe('none');
    expect(analysis.hint.subQueryCount).toBe(0);
    expect(analysis.hint.confidence).toBe(0);
    expect(analysis.hint.reason).toBe('no_decomposition_detected');
  });

  it('recommend_one intent surfaces in hint.reason', () => {
    const analysis = analyzeQueryDecomposition(
      'Opus One랑 Screaming Eagle 중에 뭐가 좋아',
    );
    expect(analysis.hint.reason).toBe('comparison:recommend_one');
  });
});
