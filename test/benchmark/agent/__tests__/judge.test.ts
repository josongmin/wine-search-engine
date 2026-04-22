import { describe, expect, it } from 'vitest';
import type { AgentBenchmarkScenario } from '../scenario.js';
import { composeJudgeEvidenceContractContext } from '../judge.js';

function exactLookupScenario(): AgentBenchmarkScenario {
  return {
    id: 1,
    tier: 'wine_name_lookup',
    query: '샤또 마고 프랑스',
    expectation: {
      maxSteps: 2,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: 'wine.chateau_margaux',
        canonicalKo: '샤또 마고',
        canonicalEn: 'Chateau Margaux',
        acceptedCanonicalAliases: ['샤토 마고', '샤또 마고', 'Chateau Margaux'],
        matchPolicy: 'exact_entity',
        phenomena: ['country-noise'],
      },
    },
  };
}

describe('composeJudgeEvidenceContractContext', () => {
  it('exposes confirmed exact lookup evidence so the rubric judge does not infer abstention', () => {
    const context = composeJudgeEvidenceContractContext(exactLookupScenario(), {
      observations: [
        [
          '[RETRIEVAL_QUALITY: reliable]',
          'EXACT_LOOKUP_CONFIRMED: exact-label target=Château Margaux; you may answer that this is the confirmed exact entity from current evidence.',
          'Found 1 results (showing top 1):',
          '1. 2022 Château Margaux Château Margaux (Premier Grand Cru Classé) | region: France / France',
        ].join('\n'),
      ],
    });

    expect(context).toContain('EXACT_LOOKUP_EVIDENCE_STATUS: CONFIRMED');
    expect(context).toContain('EXPECTED_CANONICAL_EN: Chateau Margaux');
    expect(context).toContain('EXACT_LOOKUP_PHENOMENA: country-noise');
    expect(context).toContain('ACCEPTED_ALIASES: 샤토 마고 | 샤또 마고 | Chateau Margaux');
    expect(context).toContain('TOP_EXACT_LOOKUP_RESULT: 1. 2022 Château Margaux Château Margaux');
    expect(context).toContain('do not require abstention');
    expect(context).toContain('user query spelling');
    expect(context).toContain('suffix-noise tokens');
  });

  it('marks exact lookup negative evidence as an abstention condition', () => {
    const context = composeJudgeEvidenceContractContext(exactLookupScenario(), {
      observations: [
        'EXACT_LOOKUP_NEGATIVE: DO NOT answer with any listed wine label as the exact answer.',
      ],
    });

    expect(context).toContain('EXACT_LOOKUP_EVIDENCE_STATUS: NEGATIVE');
    expect(context).toContain('honest abstention is expected');
  });

  it('returns undefined outside exact lookup scenarios', () => {
    const context = composeJudgeEvidenceContractContext({
      id: 2,
      tier: 'single_shot',
      query: '보르도 추천',
      expectation: { maxSteps: 2 },
    });

    expect(context).toBeUndefined();
  });
});
