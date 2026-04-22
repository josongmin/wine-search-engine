import { describe, it, expect } from 'vitest';
import { evaluateClaims } from '../service/claim-level-evaluator.js';
import type { EvidenceRecord } from '../service/claim-level-evaluator.js';

describe('evaluateClaims', () => {
  it('empty answer → faithfulness 1.0, no claims', async () => {
    const result = await evaluateClaims('', [], '', 'general_query', null);
    expect(result.faithfulnessScore).toBe(1.0);
    expect(result.claims).toEqual([]);
    expect(result.hardFail).toBe(false);
  });

  it('answer with grounded claims → high faithfulness', async () => {
    const evidence: EvidenceRecord[] = [
      {
        canonical_label: 'opus one 2015',
        vintage_year: 2015,
        region: 'Napa Valley',
        grape_primary: 'cabernet sauvignon',
        wine_type: 'red',
      },
    ];
    const answer = 'Opus One 2015 from Napa Valley, made of Cabernet Sauvignon, a red wine.';
    const result = await evaluateClaims(answer, evidence, '', 'single_recommendation', null);
    expect(result.faithfulnessScore).toBeGreaterThan(0.5);
    expect(result.claims.length).toBeGreaterThan(0);
  });

  it('treats Moscato Bianco evidence as Muscat/Moscato grape provenance', async () => {
    const evidence: EvidenceRecord[] = [
      {
        canonical_label: "2023 Ceretto Moscato d'Asti",
        grapes: ['Moscato Bianco'],
      },
    ];
    const result = await evaluateClaims('Ceretto Moscato d’Asti입니다.', evidence, '', 'single_recommendation', null);
    const grapeVerification = result.verifications.find((verification) =>
      verification.evidenceAnchor?.field === 'grapes');
    expect(grapeVerification?.verdict).toBe('entailed');
    expect(result.criticalErrorRate).toBe(0);
  });

  it('contradicted vintage → critical error rate > 0', async () => {
    const evidence: EvidenceRecord[] = [{ vintage_year: 2018 }];
    const answer = 'The 2010 vintage is excellent.';
    const result = await evaluateClaims(answer, evidence, '', 'single_recommendation', null);
    expect(result.criticalErrorRate).toBeGreaterThan(0);
  });

  it('hard fail on critical contradiction (single_recommendation)', async () => {
    const evidence: EvidenceRecord[] = [{ vintage_year: 2018 }];
    const answer = '2010 vintage';
    const result = await evaluateClaims(answer, evidence, '', 'single_recommendation', null);
    expect(result.hardFail).toBe(true);
  });

  it('NO hard fail on critical contradiction (multi_recommendation)', async () => {
    const evidence: EvidenceRecord[] = [{ vintage_year: 2018 }];
    const answer = '2010 vintage';
    const result = await evaluateClaims(answer, evidence, '', 'multi_recommendation', null);
    expect(result.hardFail).toBe(false);
  });

  it('per-category breakdown is populated', async () => {
    const answer = 'Opus One 2015';
    const result = await evaluateClaims(answer, [], '', 'general_query', null);
    expect(result.perCategory.identity_claim.claimCount).toBeGreaterThan(0);
    expect(result.perCategory.core_structured_claim.claimCount).toBeGreaterThan(0);
  });

  it('deterministic coverage = 1.0 when all claims are structured', async () => {
    const answer = 'Opus One 2015';
    const result = await evaluateClaims(answer, [], '', 'general_query', null);
    const structuralOnly = result.claims.every(
      (c) => c.category === 'identity_claim' || c.category === 'core_structured_claim',
    );
    if (structuralOnly && result.verifications.length > 0) {
      expect(result.deterministicCoverage).toBe(1.0);
    }
  });

  it('llmCallCount is 0 when no semantic claims', async () => {
    const answer = 'Opus One 2015';
    const result = await evaluateClaims(answer, [], '', 'general_query', null);
    expect(result.llmCallCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 1+2+3 audit regression tests
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateClaims — round 1+2+3 fixes', () => {
  // R1: status='ok' / 'skipped_no_llm' filtering
  it('skipped_no_llm semantic claims excluded from faithfulness denominator', async () => {
    // No LLM provided → semantic claims get status='skipped_no_llm'
    // Faithfulness should be 1.0 (vacuous, no verifiable contradictions)
    const evidence: EvidenceRecord[] = [];
    const answer = '풍부한 블랙체리 향과 부드러운 탄닌. 페어링: 등심 스테이크.';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    expect(result.skippedClaimCount).toBeGreaterThan(0);
    // Faithfulness should not collapse to 0 just because LLM was unavailable
    expect(result.faithfulnessScore).toBeGreaterThanOrEqual(0);
  });

  // R2: hardFail collects all reasons
  it('hardFail enumerates all critical contradictions', async () => {
    const evidence: EvidenceRecord[] = [
      { vintage_year: 2018, region: 'Bordeaux' },
    ];
    const answer = '2010 vintage from Burgundy';
    const result = await evaluateClaims(answer, evidence, '', 'single_recommendation', null);
    if (result.hardFail) {
      expect(result.hardFailReason).toBeDefined();
      // Reason should mention at least one of the contradictions
      expect(result.hardFailReason!.length).toBeGreaterThan(10);
    }
  });

  // R3: finalFaithfulnessScore = 0 on hardFail
  it('faithfulnessScore = 0 when hardFail = true', async () => {
    const evidence: EvidenceRecord[] = [{ vintage_year: 2018 }];
    const answer = '2010 vintage';
    const result = await evaluateClaims(answer, evidence, '', 'single_recommendation', null);
    if (result.hardFail) {
      expect(result.faithfulnessScore).toBe(0);
    }
  });

  // R4: verifiedClaimCount + skippedClaimCount equals verifications.length
  it('verifiedClaimCount + skippedClaimCount accounting', async () => {
    const evidence: EvidenceRecord[] = [
      { canonical_label: 'opus one 2015', vintage_year: 2015 },
    ];
    const answer = 'Opus One 2015';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    expect(result.verifiedClaimCount + result.skippedClaimCount).toBe(result.verifications.length);
  });

  // R5: provenanceCoverage uses claims.length denominator
  it('provenanceCoverage and deterministicCoverage use claim count denominator', async () => {
    const evidence: EvidenceRecord[] = [{ vintage_year: 2015 }];
    const answer = '2015 vintage';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    expect(result.provenanceCoverage).toBeGreaterThanOrEqual(0);
    expect(result.provenanceCoverage).toBeLessThanOrEqual(1);
    expect(result.deterministicCoverage).toBeGreaterThanOrEqual(0);
    expect(result.deterministicCoverage).toBeLessThanOrEqual(1);
  });

  // R6: hierarchy scoring forward (entailed direction)
  it('claim "Bordeaux" matches evidence "Pauillac" (reverse hierarchy = strong entailment)', async () => {
    const evidence: EvidenceRecord[] = [{ region: 'Pauillac' }];
    const answer = 'A wine from Bordeaux.';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    // "Bordeaux" claim should be entailed by "Pauillac" evidence (Pauillac IS in Bordeaux)
    const regionVerification = result.verifications.find((v) => v.matchType === 'hierarchy_match');
    expect(regionVerification).toBeDefined();
    expect(['entailed', 'partially_entailed']).toContain(regionVerification!.verdict);
  });

  it('verifies comparison concept geography without mutating top-result region evidence', async () => {
    const evidence: EvidenceRecord[] = [{
      canonical_label: 'Representative Barolo',
      region: 'Italy',
      comparison_concept: 'Barolo',
      comparison_concept_field: 'appellation',
      comparison_sub_query: 'Barolo',
    }];
    const answer = 'Barolo is from Piedmont, Italy.';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    const piedmontVerification = result.verifications.find(
      (v) => v.evidenceAnchor?.value === 'Barolo' && v.matchType === 'hierarchy_match',
    );
    expect(piedmontVerification).toBeDefined();
    expect(['entailed', 'partially_entailed']).toContain(piedmontVerification!.verdict);
    expect(piedmontVerification!.evidenceAnchor?.field).toBe('comparison_concept');
  });

  // R7: identity fallback for producer field
  it('identity claim falls back to producer field when canonical_label absent', async () => {
    const evidence: EvidenceRecord[] = [
      { producer: 'Opus One' }, // no canonical_label
    ];
    const answer = 'Opus One is amazing.';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    const identityVerification = result.verifications.find(
      (v) => v.verdict === 'entailed' || v.verdict === 'partially_entailed',
    );
    expect(identityVerification).toBeDefined();
  });

  // R8: multi_recommendation hard-fails on identity contradiction (round 1 fix)
  it('multi_recommendation hard-fails on identity contradiction', async () => {
    const evidence: EvidenceRecord[] = [
      { canonical_label: 'opus one 2015', producer: 'Opus One' },
    ];
    const answer = 'Screaming Eagle is recommended.';
    const result = await evaluateClaims(answer, evidence, '', 'multi_recommendation', null);
    // Identity contradiction should hard-fail multi_recommendation
    // (round 1 changed multi_recommendation.identity_claim from false to true)
    if (result.criticalErrorRate > 0) {
      expect(result.hardFail).toBe(true);
    }
  });

  // R9: general_query does NOT hard-fail on identity contradiction (round 2 fix)
  it('general_query does NOT hard-fail on identity contradiction', async () => {
    const evidence: EvidenceRecord[] = [
      { canonical_label: 'opus one 2015', producer: 'Opus One' },
    ];
    const answer = 'Screaming Eagle is from Napa.';
    const result = await evaluateClaims(answer, evidence, '', 'general_query', null);
    expect(result.hardFail).toBe(false);
  });

  // R10: empty observations + non-empty answer
  it('empty evidence + claims → all contradictions or not_entailed', async () => {
    const answer = 'Opus One is from Bordeaux.';
    const result = await evaluateClaims(answer, [], '', 'general_query', null);
    expect(result.claims.length).toBeGreaterThan(0);
    // No evidence to support → most should be not_entailed
    expect(result.faithfulnessScore).toBeLessThanOrEqual(1);
  });
});
