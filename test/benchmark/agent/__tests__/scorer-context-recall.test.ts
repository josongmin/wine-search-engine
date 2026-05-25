import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('RAGAS Context Recall', () => {
  it('goldenKeywords present and keywords appear in observations → recall = 1', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one', 'ridge monte bello'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: [
          '1. Opus One 2018 Robert Mondavi (id: opus-one-2018)',
          '2. Ridge Monte Bello 2019 (id: ridge-monte-bello-2019)',
        ],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('goldenKeywords present but none appear in observations → recall = 0, diagnostic emitted', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château pétrus', 'screaming eagle'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Some Other Wine (id: other-wine-999)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_RECALL_LOW')).toBe(true);
  });

  it('scenario without goldenKeywords → recall is null (diagnostic only)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        observations: ['1. Opus One 2018 (id: opus-one-2018)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBeNull();
  });

  it('partial recall: only some keywords in observations → 0 < recall < 1', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one', 'almaviva', 'petrus'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Opus One 2019 (id: opus-one-2019) · 2. Almaviva 2019 (id: almaviva-2019)'],
      }),
      undefined,
    );
    // 2 of 3 keywords found → recall = 2/3 ≈ 0.667
    expect(r.scores.contextRecall).toBeCloseTo(2 / 3, 5);
  });

  it('no observations with goldenKeywords → recall is null', () => {
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({ observations: [] }),
      undefined,
    );
    expect(r.scores.contextRecall).toBeNull();
  });

  it('keyword matching is case-insensitive', () => {
    // "Château Margaux" in obs vs lowercase "château margaux" in goldenKeywords — case only
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Château Margaux 2018 (id: chateau-margaux-2018)'],
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('keyword matching handles precomposed vs decomposed Unicode (NFKC)', () => {
    // keyword uses precomposed é (U+00E9); observation uses decomposed e + combining accent (U+0301).
    // NFKC normalization must convert both to the same form before matching.
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },  // precomposed é in château
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Cha\u0302teau Margaux 2018 (id: chateau-margaux-2018)'],  // â decomposed
      }),
      undefined,
    );
    // NFKC normalizes both to identical canonical form → match
    expect(r.scores.contextRecall).toBe(1.0);
  });

  it('vintage-qualified goldenKeywords do not match different vintages', () => {
    // scenario #1 uses 'opus one 2018' to avoid matching "Opus One Overture 2019"
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['opus one 2018'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Opus One Overture 2019 (id: opus-one-overture-2019)'],  // wrong vintage
      }),
      undefined,
    );
    expect(r.scores.contextRecall).toBe(0);  // '2018' not in observation → miss
  });

  it('two-word phrase goldenKeyword prevents AOC-region false matches', () => {
    // 'château margaux' (two words) won't match "Château Brane-Cantenac Margaux de Brane"
    const scenario = makeScenario(
      { maxSteps: 5 },
      { goldenKeywords: ['château margaux'] },
    );
    const r = scoreScenario(
      scenario,
      makeExecution({
        observations: ['1. Château Brane-Cantenac Margaux de Brane (id: brane-cantenac-margaux-de-brane)'],
      }),
      undefined,
    );
    // "château margaux" NOT present as consecutive substring → recall = 0
    expect(r.scores.contextRecall).toBe(0);
  });

  it('contextRecall weight is 0 in DEFAULT_WEIGHTS — does not affect overall', () => {
    // Two identical scenarios except one has goldenKeywords with 0% hit.
    // Both should produce the same overall score because weight=0.
    const base = makeScenario({ maxSteps: 5 });
    const withKeywords = makeScenario({ maxSteps: 5 }, { goldenKeywords: ['petrus'] });
    const exec = makeExecution({ observations: ['1. Opus One (id: opus-one-nv)'] });
    const rBase = scoreScenario(base, exec, undefined);
    const rWithKeywords = scoreScenario(withKeywords, exec, undefined);
    // contextRecall=null (base) vs 0 (withKeywords) — overall must be equal
    // since contextRecall weight=0.
    expect(rWithKeywords.scores.contextRecall).toBe(0);
    expect(rBase.scores.contextRecall).toBeNull();
    expect(rWithKeywords.scores.overall).toBeCloseTo(rBase.scores.overall, 4);
  });
});

