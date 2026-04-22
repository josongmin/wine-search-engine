import { describe, it, expect } from 'vitest';
import { verifyDeterministic } from '../service/claim-verifier-deterministic.js';
import type { EvidenceRecord } from '../service/claim-verifier-deterministic.js';
import type { ExtractedClaim } from '../model/claim.js';

function makeClaim(field: string, value: string, category: 'identity_claim' | 'core_structured_claim' | 'derived_structured_claim' = 'core_structured_claim'): ExtractedClaim {
  return {
    id: `${field}-${value}`,
    category,
    field: field as any,
    value,
    normalizedValue: value.toLowerCase(),
    sourceText: value,
  };
}

describe('verifyDeterministic — exact match', () => {
  it('exact string match returns entailed', () => {
    const claim = makeClaim('canonical_label', 'Opus One');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one', entity_id: 'wine-1' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('exact_match');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('exact numeric vintage match returns entailed', () => {
    const claim = makeClaim('vintage_year', '2015');
    const evidence: EvidenceRecord[] = [{ vintage_year: 2015 }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('exact_match');
  });

  it('uses evidence-frame provenance metadata for anchors when present', () => {
    const claim = makeClaim('canonical_label', 'Opus One');
    const evidence: EvidenceRecord[] = [{
      canonical_label: 'opus one',
      entity_id: 'wine-1',
      __source_tool_name: 'compare_wines',
      __source_step_index: 3,
      __source_tool_call_id: 'req-1-s3-p0',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.evidenceAnchor?.source).toEqual({
      type: 'tool_observation',
      stepIndex: 3,
      toolName: 'compare_wines',
    });
  });
});

describe('verifyDeterministic — region hierarchy', () => {
  it('Pauillac claim matches Bordeaux evidence (hierarchy)', () => {
    const claim = makeClaim('region', 'Pauillac');
    const evidence: EvidenceRecord[] = [{ region: 'Bordeaux' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('hierarchy_match');
    expect(['entailed', 'partially_entailed']).toContain(result.verdict);
  });

  it('Napa Valley claim matches California evidence', () => {
    const claim = makeClaim('region', 'Napa Valley');
    const evidence: EvidenceRecord[] = [{ region: 'California' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('hierarchy_match');
  });

  it('unrelated regions → no_match → not_entailed', () => {
    const claim = makeClaim('region', 'Bordeaux');
    const evidence: EvidenceRecord[] = [{ region: 'Napa Valley' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('no_match');
  });
});

describe('verifyDeterministic — grape alias', () => {
  it('Shiraz claim matches Syrah evidence', () => {
    const claim = makeClaim('grape_primary', 'Shiraz');
    const evidence: EvidenceRecord[] = [{ grape_primary: 'syrah' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('normalized_match');
    expect(result.verdict).toBe('entailed');
  });

  it('grape_primary claim matches grapes array evidence', () => {
    const claim = makeClaim('grape_primary', 'Nebbiolo');
    const evidence: EvidenceRecord[] = [{ grapes: ['Nebbiolo'] }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.evidenceAnchor?.field).toBe('grapes');
  });

  it('matches grape in array evidence', () => {
    const claim = makeClaim('grapes', 'Cabernet Sauvignon');
    const evidence: EvidenceRecord[] = [{ grapes: ['cabernet sauvignon', 'merlot'] }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
  });
});

describe('verifyDeterministic — wine type normalization', () => {
  it('Korean 로제 matches rosé evidence', () => {
    const claim = makeClaim('wine_type', '로제');
    const evidence: EvidenceRecord[] = [{ wine_type: 'rosé' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
  });
});

describe('verifyDeterministic — range match', () => {
  it('price within ±15% → range match', () => {
    const claim = makeClaim('price_usd', '100', 'core_structured_claim');
    const evidence: EvidenceRecord[] = [{ price_usd: 110 }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('range_match');
  });

  it('price beyond tolerance → no_match → contradicted', () => {
    const claim = makeClaim('price_usd', '100', 'core_structured_claim');
    const evidence: EvidenceRecord[] = [{ price_usd: 500 }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('no_match');
    expect(result.verdict).toBe('contradicted');
  });

  it('body within ±0.15 → range match', () => {
    const claim = makeClaim('body', '0.7', 'derived_structured_claim');
    const evidence: EvidenceRecord[] = [{ body: 0.8 }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('range_match');
  });

  it('vintage exact only — 2014 vs 2015 → contradicted', () => {
    const claim = makeClaim('vintage_year', '2014');
    const evidence: EvidenceRecord[] = [{ vintage_year: 2015 }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('contradicted');
  });
});

describe('verifyDeterministic — no evidence', () => {
  it('empty evidence → no_match → not_entailed (not contradicted)', () => {
    const claim = makeClaim('region', 'Bordeaux');
    const result = verifyDeterministic(claim, []);
    expect(result.matchType).toBe('no_match');
    expect(result.verdict).toBe('not_entailed');
  });

  it('field missing from evidence → no_match', () => {
    const claim = makeClaim('vintage_year', '2015');
    const evidence: EvidenceRecord[] = [{ region: 'Bordeaux' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('no_match');
    expect(result.verdict).toBe('not_entailed');
  });
});

// ---------------------------------------------------------------------------
// Korean ↔ Latin cross-script wine name matching
// ---------------------------------------------------------------------------
//
// These tests validate that Korean-surface claims (how Korean users and the
// Korean-speaking agent express wine identities) match Latin-surface evidence
// (how the agent-tools summarizer emits canonical labels). Without the reverse
// romanization layer, Korean claims fail deterministic verification entirely,
// which was the root cause of the <1% faithfulness score observed in RFC-020.

describe('verifyDeterministic — Korean↔Latin cross-script matching', () => {
  it('Korean claim "오푸스 원 2018" matches Latin evidence "opus one 2018"', () => {
    const claim = makeClaim('canonical_label', '오푸스 원 2018', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one 2018', entity_id: 'wine-1' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('normalized_match');
  });

  it('Korean typo "오퍼스원" normalizes to "오푸스원" and matches "Opus One"', () => {
    const claim = makeClaim('canonical_label', '오퍼스원', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one', entity_id: 'wine-1' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
  });

  it('Korean "돔 페리뇽" matches Latin "dom pérignon 2012"', () => {
    const claim = makeClaim('canonical_label', '돔 페리뇽', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'dom pérignon 2012', entity_id: 'wine-dp' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
  });

  it('Korean "샤또 마고 2015" matches Latin "château margaux 2015"', () => {
    const claim = makeClaim('canonical_label', '샤또 마고 2015', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'château margaux 2015', entity_id: 'wine-cm' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
  });

  it('unknown Korean wine term (not in exception dictionary) does NOT fabricate a match', () => {
    // "무명 와인" = "nameless wine" — not in the curated dictionary.
    // Romanization fails; the Korean chars cannot substring-match Latin evidence → no_match.
    // Verdict is `contradicted` (not `not_entailed`) because evidence DOES have the
    // canonical_label field, so the verifier saw evidence but couldn't match — this is
    // pre-existing semantics in verifyDeterministic. The critical invariant is that the
    // cross-script path must NEVER produce `entailed` or `partially_entailed` for a term
    // absent from the dictionary.
    const claim = makeClaim('canonical_label', '무명 와인', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'some wine', entity_id: 'wine-x' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.matchType).toBe('no_match');
    expect(['contradicted', 'not_entailed']).toContain(result.verdict);
  });

  it('Latin-only containment still returns partially_entailed (not affected by cross-script)', () => {
    // Regression: Hangul-gated romanization must not alter the Latin-to-Latin path.
    // "Opus One" (8) contained in "opus one 2015" (13) → ratio 0.615, floored to
    // LABEL_CONTAINMENT_FORWARD_FLOOR = 0.7 → partially_entailed. This is the
    // pre-existing behavior for containment matches.
    const claim = makeClaim('canonical_label', 'Opus One', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one 2015', entity_id: 'wine-1' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('partially_entailed');
    expect(result.matchType).toBe('normalized_match');
  });

  it('treats catalog labels missing only leading vintage decoration as fully entailed', () => {
    const claim = makeClaim('canonical_label', 'Château Margaux Château Margaux (Premier Grand Cru Classé)', 'identity_claim');
    const evidence: EvidenceRecord[] = [{
      canonical_label: '2022 Château Margaux Château Margaux (Premier Grand Cru Classé)',
      entity_id: 'wine-margaux',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('normalized_match');
  });

  it('treats labels missing only a leading vintage as fully entailed', () => {
    const claim = makeClaim('canonical_label', 'Penfolds Grange', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: '2019 Penfolds Grange', entity_id: 'wine-grange' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('normalized_match');
  });

  it('treats slash-delimited region path segments as exact structured evidence', () => {
    const claim = makeClaim('region', 'Bordeaux', 'core_structured_claim');
    const evidence: EvidenceRecord[] = [{
      region: 'France / Pomerol / France / Bordeaux / Libournais / Pomerol',
      entity_id: 'wine-petrus',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('exact_match');
  });

  it('Latin-only EXACT match still returns entailed', () => {
    // Exact-match path bypasses containment entirely — regression guard.
    const claim = makeClaim('canonical_label', 'Opus One', 'identity_claim');
    const evidence: EvidenceRecord[] = [{ canonical_label: 'opus one', entity_id: 'wine-1' }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('entailed');
    expect(result.matchType).toBe('exact_match');
  });

  it('does not mark structured sublabels as contradicted identity claims', () => {
    const claim = makeClaim('canonical_label', 'Delle Venezie', 'identity_claim');
    const evidence: EvidenceRecord[] = [{
      canonical_label: 'cesari pinot grigio',
      appellation: 'delle venezie',
      entity_id: 'wine-structured',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('not_entailed');
    expect(result.evidenceAnchor?.field).toBe('appellation');
    expect(result.explanation).toContain('structured field');
  });

  it('treats producer shards as partial identity matches instead of contradictions', () => {
    const claim = makeClaim('canonical_label', 'Moët', 'identity_claim');
    const evidence: EvidenceRecord[] = [{
      canonical_label: 'moët & chandon brut impérial nv',
      producer: 'moët & chandon',
      entity_id: 'wine-moet',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('partially_entailed');
    expect(result.matchType).toBe('normalized_match');
  });

  it('treats gapped label aliases as partial identity matches', () => {
    const claim = makeClaim('canonical_label', 'Abremundos Red Blend', 'identity_claim');
    const evidence: EvidenceRecord[] = [{
      canonical_label: '2014 Abremundos Wines Octava Alta Red Blend',
      entity_id: 'wine-abremundos',
    }];
    const result = verifyDeterministic(claim, evidence);
    expect(result.verdict).toBe('partially_entailed');
    expect(result.matchType).toBe('normalized_match');
  });
});
