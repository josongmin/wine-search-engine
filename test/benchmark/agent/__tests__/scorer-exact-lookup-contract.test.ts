import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('scoreScenario — exact lookup contract', () => {
  it('records exactLookupHit=1 when the expected canonical wine appears in evidence', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '사시까이아',
        canonicalEn: 'Sassicaia',
        acceptedCanonicalAliases: ['사시카이아'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['common-korean-variant'],
      },
    });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.sassicaia","canonical_label":"2019 Tenuta San Guido Sassicaia"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.exactLookupHit).toBe(1);
    expect(result.scores.answerQuality).toBe(1);
  });

  it('treats accented exact labels as context recall hits for transliteration lookup', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      answerMustMatch: ['(샤토\\s*마고|chateau\\s*margaux)'],
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '샤또 마고',
        canonicalEn: 'Chateau Margaux',
        acceptedCanonicalAliases: ['샤토 마고', 'Château Margaux'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['transliteration-variant'],
      },
    }, { query: '샤토 마고 보르도' });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine-ce-1","canonical_label":"2022 Château Margaux Château Margaux (Premier Grand Cru Classé)"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.exactLookupHit).toBe(1);
    expect(result.scores.contextRelevance).toBe(1);
    expect(result.scores.contextRecall).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'CONTEXT_RECALL_LOW')).toBe(false);
  });

  it('penalizes exact lookup misses when nearby but wrong canonicals are returned', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '사시까이아',
        canonicalEn: 'Sassicaia',
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
    });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.ornellaia","canonical_label":"2019 Ornellaia Bolgheri Superiore"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.exactLookupHit).toBe(0);
    expect(result.scores.answerQuality).toBeCloseTo(0.35, 5);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_MISS')).toBe(true);
  });

  it('skips exact lookup miss penalties when the tool explicitly marks exact resolution unconfirmed', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '샤또 페트뤼스',
        canonicalEn: 'Pétrus',
        acceptedCanonicalAliases: ['Petrus', '페트뤼스'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        mustNotReturnCanonicalAliases: ['Pomerol'],
        phenomena: ['alias'],
      },
    });

    const execution = makeExecution({
      observations: [
        'RESOLUTION_NOT_CONFIRMED: Exact-label contract target=Pétrus. GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.nearby","canonical_label":"2012 Château Pétrus Saute-Loup Reserve de la Famille Pomerol"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, 1);
    expect(result.scores.exactLookupHit).toBeNull();
    expect(result.scores.answerQuality).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_SKIPPED_NO_EVIDENCE_ABSTENTION')).toBe(true);
  });

  it('records failClosedAccuracy=1 when ambiguous exact lookup returns no exact candidates', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        canonicalKo: '샤또 마고',
        canonicalEn: 'Château Margaux',
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Château Margaux', '샤또 마고'],
        phenomena: ['underspecified'],
      },
    }, { query: '마고' });

    const execution = makeExecution({
      observations: ['검색 결과가 없습니다'],
    });

    const result = scoreScenario(scenario, execution, 1);
    expect(result.scores.failClosedAccuracy).toBe(1);
    expect(result.scores.answerQuality).toBe(1);
  });

  it('does not penalize answerMustMatch when an allowed exact lookup abstains with no evidence', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      answerMustMatch: ['(mo[eë]t|모엣|chandon|샹동)'],
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: 'wine.moet_chandon_rose_imperial',
        canonicalKo: '모엣 샹동 로제 임페리얼',
        canonicalEn: 'Moët & Chandon Rosé Impérial',
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
    }, { query: '모엣샹동 로제 임페리얼' });

    const execution = makeExecution({
      answer: '와인명이 단일 정확한 엔티티로 확인되지 않았습니다.',
      observations: ['[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다.'],
    });

    const result = scoreScenario(scenario, execution, 1);
    expect(result.scores.answerQuality).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'ANSWER_MUST_MATCH_MISS')).toBe(false);
  });

  it('normalizes acceptable judge variance for allowed no-evidence exact lookup abstentions', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: 'wine.moet_chandon_rose_imperial',
        canonicalKo: '모엣 샹동 로제 임페리얼',
        canonicalEn: 'Moët & Chandon Rosé Impérial',
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
    }, { query: '모엣샹동 로제 임페리얼' });

    const execution = makeExecution({
      answer: '현재 검색 결과로는 정확한 단일 와인으로 확인되지 않았습니다.',
      observations: ['[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다.'],
    });

    const result = scoreScenario(scenario, execution, 0.75);
    expect(result.scores.judge).toBe(1);
  });

  it('normalizes acceptable judge variance when the exact lookup contract is deterministically hit', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: 'wine.petrus',
        canonicalKo: '샤또 페트뤼스',
        canonicalEn: 'Pétrus',
        acceptedCanonicalAliases: ['Petrus', 'Château Pétrus'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['transliteration-variant'],
      },
    }, { query: '페트뤼스 어떤 와인이야?' });

    const execution = makeExecution({
      observations: [
        'EXACT_LOOKUP_CONFIRMED: exact-label target=Pétrus\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.petrus","canonical_label":"2012 Château Pétrus","producer":"Château Pétrus"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, 0.75);
    expect(result.scores.exactLookupHit).toBe(1);
    expect(result.scores.judge).toBe(1);
  });

  it('skips context relevance for fail-closed exact lookup hard negatives', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Moët & Chandon Rosé Impérial'],
        phenomena: ['brand-family-ambiguous'],
      },
    }, { query: '모엣 로제' });

    const execution = makeExecution({
      observations: [
        'EXACT_LOOKUP_NEGATIVE: DO NOT answer with any listed wine label as the exact answer.\nGROUNDING_JSON: {"query_type":"search","total_results":50,"wines":[],"exact_lookup_negative":{"target":"모엣 로제"}}',
      ],
    });

    const result = scoreScenario(scenario, execution, 1);
    expect(result.scores.failClosedAccuracy).toBe(1);
    expect(result.scores.contextRelevance).toBeNull();
    expect(result.diagnostics?.some((d) => d.code === 'CONTEXT_RELEVANCE_SKIPPED_FAIL_CLOSED_EXACT_LOOKUP')).toBe(true);
  });

  it('normalizes acceptable judge variance when fail-closed exact lookup contract is deterministically hit', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Moët & Chandon Rosé Impérial'],
        phenomena: ['wrong-brand-nearby'],
      },
    }, { query: '샹동 로제' });

    const execution = makeExecution({
      observations: [
        'EXACT_LOOKUP_NEGATIVE: DO NOT answer with any listed wine label as the exact answer.\nGROUNDING_JSON: {"query_type":"search","total_results":50,"wines":[],"exact_lookup_negative":{"target":"샹동 로제"}}',
      ],
    });

    const result = scoreScenario(scenario, execution, 0.75);
    expect(result.scores.failClosedAccuracy).toBe(1);
    expect(result.scores.judge).toBe(1);
  });

  it('penalizes fail-closed violations when ambiguous exact lookup returns a specific exact candidate', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        canonicalKo: '샤또 마고',
        canonicalEn: 'Château Margaux',
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Château Margaux', '샤또 마고'],
        phenomena: ['underspecified'],
      },
    }, { query: '마고' });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.chateau_margaux","canonical_label":"2018 Château Margaux"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.failClosedAccuracy).toBe(0);
    expect(result.scores.answerQuality).toBeCloseTo(0.1225, 5);
    expect(result.diagnostics?.some((d) => d.code === 'FAIL_CLOSED_EXACT_LOOKUP_VIOLATED')).toBe(true);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_FORBIDDEN_MATCH')).toBe(true);
  });

  it('passes guarded hard negatives when retrieval returns non-guarded category candidates', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_return_guarded_entity',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Pétrus', 'Château Pétrus', '샤또 페트뤼스'],
        phenomena: ['descriptive-category'],
      },
    }, { query: '메를로 명작' });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.columbia_crest_merlot","canonical_label":"2021 Columbia Crest Soft Merlot"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.failClosedAccuracy).toBe(1);
    expect(result.scores.answerQuality).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'FAIL_CLOSED_EXACT_LOOKUP_VIOLATED')).toBe(false);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_FORBIDDEN_MATCH')).toBe(false);
  });

  it('penalizes guarded hard negatives when retrieval returns a guarded canonical alias', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_return_guarded_entity',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Château Margaux', '샤또 마고'],
        phenomena: ['descriptive-category'],
      },
    }, { query: '프랑스 명문 레드' });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.chateau_margaux","canonical_label":"Château Margaux 2015"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.failClosedAccuracy).toBe(0);
    expect(result.scores.answerQuality).toBeCloseTo(0.35, 5);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_FORBIDDEN_MATCH')).toBe(true);
  });

  it('does not treat generic forbidden aliases as violations inside the expected exact canonical label', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: 'wine.chateau_margaux',
        canonicalKo: '샤또 마고',
        canonicalEn: 'Chateau Margaux',
        acceptedCanonicalAliases: ['샤토 마고', 'Château Margaux'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        mustNotReturnCanonicalAliases: ['Margaux', '마고'],
        phenomena: ['region-noise'],
      },
    }, { query: '샤토 마고 보르도' });

    const execution = makeExecution({
      observations: [
        'GROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"wine.chateau_margaux","canonical_label":"2022 Château Margaux Château Margaux (Premier Grand Cru Classé)"}]}',
      ],
    });

    const result = scoreScenario(scenario, execution, undefined);
    expect(result.scores.exactLookupHit).toBe(1);
    expect(result.scores.answerQuality).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_FORBIDDEN_MATCH')).toBe(false);
  });

  it('treats optional alias-or-fail-closed as pass when no exact evidence is returned', () => {
    const scenario = makeScenario({
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '샤또 페트뤼스',
        canonicalEn: 'Pétrus',
        acceptedCanonicalAliases: ['Petrus', '페트뤼스', '페트루스'],
        matchPolicy: 'optional_alias_or_fail_closed',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['transliteration-variant'],
      },
      allowHonestNoEvidenceAbstention: true,
    }, { query: '페트루스' });

    const execution = makeExecution({
      observations: ['[retrieval_quality: unreliable — 0 results]'],
    });

    const result = scoreScenario(scenario, execution, 1);
    expect(result.scores.exactLookupHit).toBeNull();
    expect(result.scores.failClosedAccuracy).toBe(1);
    expect(result.diagnostics?.some((d) => d.code === 'EXACT_LOOKUP_SKIPPED_NO_EVIDENCE_ABSTENTION')).toBe(true);
  });
});
