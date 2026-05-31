import { describe, expect, it } from 'vitest';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import {
  collectGroundingFacts,
  normalizeClaimSurface,
  verifyAnswerGrounding,
} from '../synthesis-grounding-verify.js';

function searchOutcome(
  wines: ReadonlyArray<{
    label?: string;
    region?: string;
    vintage?: number;
    vintage_year?: number;
    grapes?: readonly string[];
    producer?: string;
    price?: string;
  }>,
  opts?: { kind?: ToolOutcome['kind'] },
): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: opts?.kind ?? 'success',
    durationMs: 1,
    result: {
      queryType: 'search',
      results: wines.map((w) => ({
        entity: {
          ...(w.label !== undefined ? { canonicalLabel: w.label } : {}),
          ...(w.region !== undefined ? { region: w.region } : {}),
          ...(w.vintage !== undefined ? { vintage: w.vintage } : {}),
          ...(w.vintage_year !== undefined ? { vintage_year: w.vintage_year } : {}),
          ...(w.grapes !== undefined ? { grapes: [...w.grapes] } : {}),
          ...(w.producer !== undefined ? { producer: w.producer } : {}),
          ...(w.price !== undefined ? { price: w.price } : {}),
        },
      })),
    },
  };
}

function groundingJsonOutcome(json: unknown): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: 'success',
    durationMs: 1,
    result: `Some summary text\nGROUNDING_JSON: ${JSON.stringify(json)}`,
  };
}

describe('synthesis-grounding-verify — normalizeClaimSurface', () => {
  it('NFC + lowercase + strips Korean josa + collapses whitespace', () => {
    expect(normalizeClaimSurface('샤또  무통은')).toBe('샤또 무통');
    expect(normalizeClaimSurface('Château  Margaux')).toBe('château margaux');
  });

  it('is a no-op-safe for empty and ASCII input', () => {
    expect(normalizeClaimSurface('')).toBe('');
    expect(normalizeClaimSurface('Opus One')).toBe('opus one');
  });
});

describe('synthesis-grounding-verify — collectGroundingFacts', () => {
  it('builds the union across multiple outcomes (structured + GROUNDING_JSON)', () => {
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A', region: 'Bordeaux', vintage: 2018, grapes: ['Merlot'] }]),
      groundingJsonOutcome({ wines: [{ canonical_label: 'Wine B', region: 'Rioja', vintage: 2019 }] }),
    ]);
    expect(facts.hasAnyFact).toBe(true);
    expect(facts.labels.has('wine a')).toBe(true);
    expect(facts.labels.has('wine b')).toBe(true);
    expect(facts.regions.has('bordeaux')).toBe(true);
    expect(facts.vintages.has('2018')).toBe(true);
    expect(facts.vintages.has('2019')).toBe(true);
    expect(facts.grapes.has('merlot')).toBe(true);
    expect(facts.wines.length).toBe(2);
    expect(facts.wines[0]?.label).toBe('wine a');
    expect(facts.wines[0]?.vintageYear).toBe(2018);
  });

  it('also accepts `vintage_year` field on grounding wines', () => {
    const facts = collectGroundingFacts([
      groundingJsonOutcome({
        wines: [{ canonical_label: 'Margaux', vintage_year: 2015 }],
      }),
    ]);
    expect(facts.vintages.has('2015')).toBe(true);
    expect(facts.wines[0]?.vintageYear).toBe(2015);
  });

  it('ignores non-grounding outcome kinds (errors/timeouts)', () => {
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A' }], { kind: 'timeout' }),
    ]);
    expect(facts.hasAnyFact).toBe(false);
  });

  it('returns hasAnyFact=false for empty outcomes', () => {
    expect(collectGroundingFacts([]).hasAnyFact).toBe(false);
  });
});

describe('synthesis-grounding-verify — verifyAnswerGrounding (baseline)', () => {
  const facts = collectGroundingFacts([
    searchOutcome([{ label: 'Wine A', region: 'Bordeaux', vintage: 2018 }]),
  ]);

  it('treats no facts as grounded (defensive)', () => {
    const empty = collectGroundingFacts([]);
    expect(verifyAnswerGrounding('anything', ['Wine Z'], empty).grounded).toBe(true);
  });

  it('grounded when a label citation matches a grounded label', () => {
    const r = verifyAnswerGrounding('I recommend Wine A.', ['Wine A'], facts);
    expect(r.grounded).toBe(true);
    expect(r.ungroundedClaims).toEqual([]);
    expect(r.trace[0]?.matchedRule?.kind).toBe('exact_nfc_lower');
  });

  it('ungrounded when a label citation is absent from grounding', () => {
    const r = verifyAnswerGrounding('I recommend Wine B.', ['Wine B'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('wine b');
    expect(r.trace[0]?.matchedRule).toBeNull();
  });

  it('skips entity-id-shaped citations (wine-001, uuids, integers)', () => {
    const r = verifyAnswerGrounding('paraphrased prose', ['wine-001', '42'], facts);
    expect(r.grounded).toBe(true);
  });

  it('flags an ungrounded vintage asserted in the answer text', () => {
    const r = verifyAnswerGrounding('The 2015 vintage is great.', ['Wine A'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('2015');
  });

  it('passes a grounded vintage assertion', () => {
    const r = verifyAnswerGrounding('The 2018 Wine A is great.', ['Wine A'], facts);
    expect(r.grounded).toBe(true);
  });

  it('does NOT flag a faithful paraphrase that cites nothing label-shaped', () => {
    const r = verifyAnswerGrounding('A lovely Bordeaux for tonight.', ['wine-001'], facts);
    expect(r.grounded).toBe(true);
  });

  it('accepts a shortened label citation that is a substring of the grounded label', () => {
    const longFacts = collectGroundingFacts([
      searchOutcome([{ label: 'Château Margaux Grand Vin 2015', vintage: 2015 }]),
    ]);
    const r = verifyAnswerGrounding('Try Château Margaux.', ['Château Margaux'], longFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('compound_subsumed_by_label');
  });

  it('handles Korean label citations with josa normalization', () => {
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '샤또 무통' }])]);
    const r = verifyAnswerGrounding('샤또 무통을 추천합니다.', ['샤또 무통은'], krFacts);
    expect(r.grounded).toBe(true);
    // After normalisation, '샤또 무통은' → '샤또 무통' which equals the grounded
    // label — `exact_nfc_lower` fires first.
    expect(r.trace[0]?.matchedRule?.kind).toBe('exact_nfc_lower');
  });
});

// ============================================================================
// Bench faith=0 hardening — failure-mode tests (L2.A/B/C/D).
//
// These cases mirror the 17 faith=0 scenarios reported by the standard agent
// benchmark. Each test carries an inline rationale tying it back to the
// hallucination pattern observed in the bench. The new rule cascade closes
// each pattern by deriving the match from existing domain primitives (alias
// catalog, transliterator EXCEPTIONS, structured grounding fields) — NO
// substring-pattern guessing on natural text.
// ============================================================================

describe('synthesis-grounding-verify — transliteration_pair (L2.B)', () => {
  it('claim "Opus One" matches grounded Korean label "오푸스원" via Transliterator EXCEPTIONS', () => {
    // Bench pattern: search tool grounded a Korean canonical surface, the
    // synthesis LLM answered in English. With only exact + substring matching
    // the surfaces never collided → faith=0.
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '오푸스원' }])]);
    const r = verifyAnswerGrounding('I recommend Opus One.', ['Opus One'], krFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('transliteration_pair');
  });

  it('claim "오퍼스 원" matches grounded "오푸스원" via korean-wine-aliases typo catalog', () => {
    // Bench pattern: user-facing answer used the common Korean misspelling
    // (오퍼스) while the grounding surface used the canonical (오푸스). Both
    // belong to the same alias equivalence class.
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '오푸스원' }])]);
    const r = verifyAnswerGrounding('오퍼스 원 추천', ['오퍼스 원'], krFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('transliteration_pair');
  });

  it('claim "오퍼스 원" matches grounded English label "Opus One" via reverse romanisation', () => {
    // Bench pattern: search returned the canonical English label, synthesis
    // answered in Korean using a misspelled variant. Both expansion directions
    // (KO→Latin and the catalog) must compose.
    const enFacts = collectGroundingFacts([searchOutcome([{ label: 'Opus One' }])]);
    const r = verifyAnswerGrounding('오퍼스 원을 추천합니다.', ['오퍼스 원'], enFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('transliteration_pair');
  });

  it('claim "샤또마고" (no space) matches grounded "Château Margaux" via catalog+EXCEPTIONS chain', () => {
    // Bench pattern: chained alias lookup — claim is a Korean typo variant
    // whose canonical Korean form is itself the EXCEPTIONS image of the
    // grounded Latin label.
    const enFacts = collectGroundingFacts([searchOutcome([{ label: 'Château Margaux', vintage: 2015 }])]);
    const r = verifyAnswerGrounding('샤또마고는 명품입니다.', ['샤또마고'], enFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('transliteration_pair');
  });

  it('claim "Sassicaia" matches grounded Korean "사시카이아"', () => {
    // Bench pattern: Italian wine name with Latin claim vs Korean grounding.
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '사시카이아' }])]);
    const r = verifyAnswerGrounding('Sassicaia is excellent.', ['Sassicaia'], krFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('transliteration_pair');
  });

  it('NEGATIVE — claim "Petrus" does NOT match grounded "Opus One"', () => {
    // Negative parity for L2.B: alias expansion must NOT bridge unrelated
    // wines. "Petrus" expands to "페트뤼스" via EXCEPTIONS but neither surface
    // intersects "Opus One" / "오푸스원".
    const krFacts = collectGroundingFacts([searchOutcome([{ label: '오푸스원' }])]);
    const r = verifyAnswerGrounding('I recommend Petrus.', ['Petrus'], krFacts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('petrus');
  });
});

describe('synthesis-grounding-verify — compound_subsumed_by_label (L2.C, no year)', () => {
  it('claim tokens ⊆ canonical_label tokens (Korean compound)', () => {
    // Bench pattern: grounding carries a long canonical label with region /
    // vintage suffix; the synthesis answer cites only the core wine name.
    const longFacts = collectGroundingFacts([
      searchOutcome([{ label: '샤또 마고 2015 메도크', vintage: 2015 }]),
    ]);
    const r = verifyAnswerGrounding('샤또 마고를 추천합니다.', ['샤또 마고'], longFacts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('compound_subsumed_by_label');
  });

  it('label tokens ⊆ claim tokens (claim adds qualifier)', () => {
    // Bench pattern: the model elaborates the canonical label with extra
    // qualifiers ("Grand Vin"). Token coverage must be symmetric.
    const facts = collectGroundingFacts([searchOutcome([{ label: 'Château Margaux' }])]);
    const r = verifyAnswerGrounding('Try Château Margaux Grand Vin.', ['Château Margaux Grand Vin'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('compound_subsumed_by_label');
  });

  it('cross-alias compound subsumption — claim "샤또 마고" / label "Château Margaux 2015 Médoc"', () => {
    // Bench pattern: combination of L2.B + L2.C — claim is Korean variant,
    // grounded label is Latin with extra qualifiers. After expanding the
    // claim to its Latin alternates we still need compound subsumption.
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Château Margaux 2015 Médoc', vintage: 2015 }]),
    ]);
    const r = verifyAnswerGrounding('샤또 마고 추천', ['샤또 마고'], facts);
    expect(r.grounded).toBe(true);
    // Either transliteration_pair (alts overlap label tokens) or compound_subsumed
    // depending on alias expansion; both are acceptable provenance.
    expect(['transliteration_pair', 'compound_subsumed_by_label']).toContain(
      r.trace[0]?.matchedRule?.kind,
    );
  });

  it('NEGATIVE — single-token claim "Margaux" does NOT match label "Latour 2015"', () => {
    // Negative: compound subsumption only fires when ALL tokens are present.
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Château Latour 2015', vintage: 2015 }]),
    ]);
    const r = verifyAnswerGrounding('Try Margaux.', ['Margaux'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('margaux');
  });
});

describe('synthesis-grounding-verify — vintage_year_field_match (L2.C with year)', () => {
  it('claim "Margaux 2015" matches grounded {label:"Margaux", vintage_year:2015}', () => {
    // Bench pattern: search ground the wine identity (label) and a separate
    // vintage_year field. The model cited the combined "{label} {year}" form
    // which the old verifier saw as a label citation that didn't equal any
    // grounded label.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: 'Margaux', vintage_year: 2015 }] }),
    ]);
    const r = verifyAnswerGrounding('Try Margaux 2015.', ['Margaux 2015'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('vintage_year_field_match');
  });

  it('claim "2015 Margaux" (year-first) also matches', () => {
    // Bench pattern: same as above, year-first ordering — common in Korean
    // wine-trade prose ("2015년 마고").
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: 'Margaux', vintage_year: 2015 }] }),
    ]);
    const r = verifyAnswerGrounding('Try 2015 Margaux.', ['2015 Margaux'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('vintage_year_field_match');
  });

  it('cross-alias vintage match — claim "Margaux 2015" vs Korean-grounded "샤또 마고"', () => {
    // Bench pattern: label-part needs alias expansion to align with the
    // grounded label, BUT the year must still match.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: '샤또 마고', vintage_year: 2015 }] }),
    ]);
    const r = verifyAnswerGrounding('Try Margaux 2015.', ['Margaux 2015'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('vintage_year_field_match');
  });

  it('NEGATIVE — claim "Margaux 2010" REJECTED when label aligned but vintage_year=2015', () => {
    // Bench pattern: this is the high-value hallucination guard — the model
    // confabulates a vintage that does NOT match the grounded vintage. The
    // compound rule would otherwise absorb the label-only tokens; the
    // vintage rule's 'reject' verdict short-circuits the cascade.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: 'Margaux', vintage_year: 2015 }] }),
    ]);
    const r = verifyAnswerGrounding('Try Margaux 2010.', ['Margaux 2010'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('margaux 2010');
  });

  it('NEGATIVE — claim with unknown year on aligned label is rejected if any grounded vintage exists', () => {
    // Bench pattern: model invents a vintage year for a real wine.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: 'Opus One', vintage_year: 2018 }] }),
    ]);
    const r = verifyAnswerGrounding('Try Opus One 2022.', ['Opus One 2022'], facts);
    expect(r.grounded).toBe(false);
  });
});

describe('synthesis-grounding-verify — structured_field_present (L2.D)', () => {
  it('claim "Bordeaux" matches grounded region:"Bordeaux"', () => {
    // Bench pattern: prose answer cites the region as the wine identifier
    // when the user asked a region-level question. The grounding union
    // carries region as a structured field, not as a label.
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A', region: 'Bordeaux' }]),
    ]);
    const r = verifyAnswerGrounding('A lovely red.', ['Bordeaux'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('structured_field_present');
  });

  it('claim "리오하" matches grounded region:"Rioja" via Transliterator EXCEPTIONS', () => {
    // Bench pattern: Korean region term cited against Latin grounded region.
    // The Transliterator EXCEPTIONS table provides the high-confidence bridge
    // for established region names ('rioja' ↔ '리오하').
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Tempranillo Reserva', region: 'Rioja' }]),
    ]);
    const r = verifyAnswerGrounding('리오하 산 와인을 추천합니다.', ['리오하'], facts);
    expect(r.grounded).toBe(true);
    expect([
      'structured_field_present',
      'compound_subsumed_by_label',
      'transliteration_pair',
    ]).toContain(r.trace[0]?.matchedRule?.kind);
  });

  it('claim "Riesling" matches grounded grape "Riesling"', () => {
    // Bench pattern: grape-level claim against grape-field grounding.
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'A Mosel Wine', grapes: ['Riesling'] }]),
    ]);
    const r = verifyAnswerGrounding('Riesling is a good choice.', ['Riesling'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('structured_field_present');
  });

  it('claim cites the producer surface — matches grounded producer field', () => {
    // Bench pattern: producer-level claim ("Penfolds wines are great").
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Some Cuvée', producer: 'Penfolds' }]),
    ]);
    const r = verifyAnswerGrounding('Penfolds is excellent.', ['Penfolds'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace[0]?.matchedRule?.kind).toBe('structured_field_present');
  });

  it('NEGATIVE — claim "Champagne" does NOT match grounded region:"Bordeaux"', () => {
    // Negative: structured-field match must NOT accept arbitrary terms.
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A', region: 'Bordeaux' }]),
    ]);
    const r = verifyAnswerGrounding('Try a Champagne.', ['Champagne'], facts);
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims).toContain('champagne');
  });
});

describe('synthesis-grounding-verify — adversarial / regression', () => {
  it('label citation that overlaps grounded label only via single common token does NOT match', () => {
    // Regression: compound_subsumed_by_label requires ALL tokens to match.
    // Sharing only "wine" must not ground "Wine X" against grounded "Wine A".
    const facts = collectGroundingFacts([
      searchOutcome([{ label: 'Wine A' }]),
    ]);
    const r = verifyAnswerGrounding('Wine X is great.', ['Wine X'], facts);
    expect(r.grounded).toBe(false);
  });

  it('empty citation list with prose containing no vintage is grounded', () => {
    // Regression: empty citations must not erroneously fire any rule.
    const facts = collectGroundingFacts([searchOutcome([{ label: 'Wine A' }])]);
    const r = verifyAnswerGrounding('Some prose.', [], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace).toEqual([]);
  });

  it('trace records the matched rule for each label-shaped citation', () => {
    // Regression: trace ordering follows citation iteration order, and only
    // label-shaped citations contribute to the trace (id-shaped are skipped).
    const facts = collectGroundingFacts([searchOutcome([{ label: 'Wine A', region: 'Bordeaux' }])]);
    const r = verifyAnswerGrounding('Wine A from Bordeaux.', ['wine-001', 'Wine A', 'Bordeaux'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace.length).toBe(2);
    expect(r.trace[0]?.claim).toBe('wine a');
    expect(r.trace[1]?.claim).toBe('bordeaux');
  });

  it('handles Korean josa together with vintage-year split', () => {
    // Regression: normalizeClaimSurface strips josa BEFORE the year-split,
    // so a citation like "샤또 마고 2015은" must still split cleanly.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: '샤또 마고', vintage_year: 2015 }] }),
    ]);
    const r = verifyAnswerGrounding('샤또 마고 2015은 최고입니다.', ['샤또 마고 2015은'], facts);
    expect(r.grounded).toBe(true);
  });

  it('Korean exact-label citation matches via exact_nfc_lower (never particle_stripped)', () => {
    // Dead-rule removal: `tryParticleStripped` previously sat AFTER
    // `tryExactNfcLower` in the cascade and shared the identical predicate
    // (`facts.labels.has(claim)`). It could therefore never fire — any Korean
    // exact-label match is already caught by exact_nfc_lower. This regression
    // pins that a Korean exact citation is grounded AND that its matched rule
    // is exact_nfc_lower, so no claim ever surfaces a particle_stripped kind.
    const facts = collectGroundingFacts([
      groundingJsonOutcome({ wines: [{ canonical_label: '샤또 마고' }] }),
    ]);
    const r = verifyAnswerGrounding('샤또 마고를 추천합니다.', ['샤또 마고'], facts);
    expect(r.grounded).toBe(true);
    expect(r.trace.length).toBe(1);
    expect(r.trace[0]?.matchedRule).toEqual({ kind: 'exact_nfc_lower' });
  });
});
