import type { AgentBenchmarkScenario } from './scenario.js';
import {
  TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIO_IDS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIOS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIO_IDS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIOS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIO_IDS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIOS,
} from './scenarios.transliteration-large.js';

/**
 * Korean robustness scenarios — intentionally messy user inputs.
 *
 * Focus:
 *   - messy_query_robustness: typos, shorthand, no-spacing, colloquial Korean
 *   - transliteration_exact_lookup: Korean transliterated exact entity / SKU lookup
 *     grounded in names commonly used in Korean wine search / retail discourse
 *
 * IDs start at 520 to avoid collisions with bundle scenarios (500-502).
 */
export const ROBUSTNESS_SCENARIOS: readonly AgentBenchmarkScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // messy_query_robustness — 개같이 쳐도 찰떡같이 알아듣는지
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 520,
    tier: 'korean_colloquial',
    query: '오푸스원 18 얼마쯤 함?',
    description: 'Typo + shorthand vintage + casual price lookup',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(opus\\s*one|오푸스\\s*원|오푸스원)', '(2018|18)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['Opus One 2018', '오푸스 원 2018', '오푸스원 2018'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
        { tool: 'search_wines', argPath: 'vintage_min', predicate: 'equals', value: 2018 },
        { tool: 'search_wines', argPath: 'vintage_max', predicate: 'equals', value: 2018 },
      ],
      rubric:
        'Must interpret "오푸스원 18 얼마쯤 함?" as an exact Opus One 2018 price/info lookup despite the typo-like spacing and shorthand vintage. '
        + 'If the live corpus cannot confirm Opus One 2018, it must abstain honestly instead of bluffing.',
    },
  },
  {
    id: 521,
    tier: 'korean_colloquial',
    query: '보졸레누보 나왔냐',
    description: 'No-space seasonal freshness query',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['보졸레누보', '보졸레 누보'] },
      ],
      rubric:
        'Must treat this as a Beaujolais Nouveau freshness / current-availability query, not a broad Beaujolais browse. '
        + 'If the live corpus cannot confirm current release evidence, honest abstention is correct.',
    },
  },
  {
    id: 522,
    tier: 'korean_colloquial',
    query: '와알못인데 레드 하나 ㄱㅊ은걸로',
    description: 'Beginner slang + shorthand recommendation',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 6_000,
      requiredRegister: 'casual',
      judgeRequired: true,
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'wine_type', predicate: 'equals', value: 'red' },
        { tool: 'search_wines', argPath: 'beginner_suitability_min', predicate: 'exists' },
      ],
      rubric:
        'Must understand "와알못" as beginner / first-timer intent and recommend an approachable red wine. '
        + 'Should explain simply why it is easy to drink, without expert-only jargon.',
    },
  },
  {
    id: 523,
    tier: 'korean_colloquial',
    query: '샤또마고 ㄹㅇ 비싼편임?',
    description: 'No-space transliteration + chat slang exact lookup',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(ch[âa]teau\\s*margaux|샤또\\s*마고|샤또마고)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['샤또 마고', '샤또마고', 'Château Margaux', 'Chateau Margaux'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must interpret this as an exact Château Margaux price/positioning query despite no spacing and chat slang. '
        + 'If grounded evidence is unavailable, it must abstain honestly rather than bluffing.',
    },
  },
  {
    id: 524,
    tier: 'korean_colloquial',
    query: '알마비바 2026 출시됨? 근거없음 모른다해',
    description: 'Messy future-vintage release query with honesty tail',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(almaviva|알마비바)', '(2026)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['알마비바 2026', 'Almaviva 2026'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
        { tool: 'search_wines', argPath: 'vintage_min', predicate: 'equals', value: 2026 },
        { tool: 'search_wines', argPath: 'vintage_max', predicate: 'equals', value: 2026 },
      ],
      rubric:
        'Must treat this as an exact future-vintage release/availability query and strip the honesty tail from the tool query. '
        + 'If the live corpus cannot confirm Almaviva 2026, explicit honest abstention is correct.',
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // transliteration_exact_lookup — 한국어 음역 exact entity / SKU lookup
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 530,
    tier: 'wine_name_lookup',
    query: '페트뤼스',
    description: 'Bare Korean transliteration exact lookup: Pétrus',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(pétrus|petrus|페트뤼스)'],
      judgeRequired: true,
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
        phenomena: ['alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['페트뤼스', 'Pétrus', 'Petrus'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 페트뤼스 as an exact Pétrus lookup, not a generic Bordeaux recommendation. '
        + 'If grounded evidence is unavailable, honest abstention is acceptable.',
    },
  },
  {
    id: 531,
    tier: 'wine_name_lookup',
    query: '돔페리뇽',
    description: 'Bare Korean transliteration exact lookup: Dom Pérignon',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(dom\\s*p[eé]rignon|돔\\s*페리뇽|돔페리뇽)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '돔 페리뇽',
        canonicalEn: 'Dom Pérignon',
        acceptedCanonicalAliases: ['Dom Perignon', '돔페리뇽'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse', 'alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['돔페리뇽', 'Dom Pérignon', 'Dom Perignon'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 돔페리뇽 as an exact Dom Pérignon lookup. '
        + 'If grounded evidence exists, answer with Champagne context; otherwise abstain honestly.',
    },
  },
  {
    id: 532,
    tier: 'wine_name_lookup',
    query: '모엣샹동 로제 임페리얼',
    description: 'Full Korean transliteration exact SKU lookup',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(mo[eë]t.*ros[eé].*imp[eé]rial|모엣샹동\\s*로제\\s*임페리얼|모엣\\s*샹동\\s*로제\\s*임페리얼)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '모엣 샹동 로제 임페리얼',
        canonicalEn: 'Moët & Chandon Rosé Impérial',
        acceptedCanonicalAliases: ['Moet Chandon Rose Imperial', '모엣샹동 로제 임페리얼'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['모엣샹동 로제 임페리얼', '모엣 샹동 로제 임페리얼', 'Moët & Chandon Rosé Impérial', 'Moet Chandon Rose Imperial', 'Moet and Chandon Rose Imperial', 'moet chandon rose imperial'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat this as an exact SKU lookup, not a broad rosé/sparkling browse. '
        + 'If the live corpus cannot confirm the exact SKU, the answer must abstain honestly.',
    },
  },
  {
    id: 533,
    tier: 'wine_name_lookup',
    query: '샤또 마고',
    description: 'Bare Korean transliteration exact lookup: Château Margaux',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(ch[âa]teau\\s*margaux|샤또\\s*마고)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '샤또 마고',
        canonicalEn: 'Château Margaux',
        acceptedCanonicalAliases: ['Chateau Margaux'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['샤또 마고', 'Château Margaux', 'Chateau Margaux'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 샤또 마고 as an exact Château Margaux lookup. '
        + 'If grounded evidence is unavailable, honest abstention is acceptable.',
    },
  },
  {
    id: 534,
    tier: 'wine_name_lookup',
    query: '사시카이아',
    description: 'Bare Korean transliteration exact lookup: Sassicaia',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(sassicaia|사시카이아)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
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
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['사시카이아', 'Sassicaia'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 사시카이아 as an exact Sassicaia lookup rather than a generic Tuscany recommendation. '
        + 'If the live corpus cannot confirm the exact wine, the answer must abstain honestly.',
    },
  },
  {
    id: 535,
    tier: 'wine_name_lookup',
    query: '오푸스원',
    description: 'Common Korean transliteration exact lookup: Opus One',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(opus\\s*one|오푸스\\s*원|오푸스원)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '오푸스 원',
        canonicalEn: 'Opus One',
        acceptedCanonicalAliases: ['오푸스원'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['space-collapse', 'alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['오푸스원', '오푸스 원', 'Opus One'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 오푸스원 as an exact Opus One lookup, not a generic Napa Cabernet browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 536,
    tier: 'wine_name_lookup',
    query: '알마비바',
    description: 'Common Korean transliteration exact lookup: Almaviva',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(almaviva|알마비바)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '알마비바',
        canonicalEn: 'Almaviva',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['알마비바', 'Almaviva'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 알마비바 as an exact Almaviva lookup rather than a generic Chilean red recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 537,
    tier: 'wine_name_lookup',
    query: '티냐넬로',
    description: 'Common Korean transliteration exact lookup: Tignanello',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(tignanello|티냐넬로)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '티냐넬로',
        canonicalEn: 'Tignanello',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['티냐넬로', 'Tignanello'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 티냐넬로 as an exact Tignanello lookup rather than a generic Tuscany / Super Tuscan browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 538,
    tier: 'wine_name_lookup',
    query: '로마네콩티',
    description: 'Common Korean transliteration exact lookup: Romanée-Conti',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(roman[ée]e\\s*conti|로마네\\s*콩티|로마네콩티|DRC)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '로마네 콩티',
        canonicalEn: 'Romanée-Conti',
        acceptedCanonicalAliases: ['Romanee Conti', 'DRC', '로마네콩티'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse', 'alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['로마네콩티', '로마네 콩티', 'Romanée-Conti', 'Romanee Conti', 'Domaine de la Romanee-Conti'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 로마네콩티 as an exact Romanée-Conti / DRC lookup, not a generic Burgundy Pinot Noir browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 539,
    tier: 'wine_name_lookup',
    query: '라피트',
    description: 'Common Korean transliteration exact lookup: Lafite',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(lafite|라피트)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '라피트',
        canonicalEn: 'Château Lafite Rothschild',
        acceptedCanonicalAliases: ['Lafite', 'Lafite Rothschild'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['라피트', 'Lafite', 'Lafite Rothschild', 'Château Lafite Rothschild', 'Chateau Lafite Rothschild'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 라피트 as an exact Château Lafite Rothschild lookup, not a broad Bordeaux recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 540,
    tier: 'wine_name_lookup',
    query: '라투르',
    description: 'Common Korean transliteration exact lookup: Latour',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(latour|라투르)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '라투르',
        canonicalEn: 'Château Latour',
        acceptedCanonicalAliases: ['Latour'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['라투르', 'Latour', 'Château Latour', 'Chateau Latour'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 라투르 as an exact Château Latour lookup, not a broad Bordeaux recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 541,
    tier: 'wine_name_lookup',
    query: '무통',
    description: 'Common Korean transliteration exact lookup: Mouton Rothschild',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(mouton|무통)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '무통',
        canonicalEn: 'Château Mouton Rothschild',
        acceptedCanonicalAliases: ['Mouton', 'Mouton Rothschild'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['무통', 'Mouton', 'Mouton Rothschild', 'Château Mouton Rothschild', 'Chateau Mouton Rothschild'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 무통 as an exact Château Mouton Rothschild lookup, not a broad Bordeaux recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 542,
    tier: 'wine_name_lookup',
    query: '슈발블랑',
    description: 'Common Korean transliteration exact lookup: Cheval Blanc',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(cheval\\s*blanc|슈발\\s*블랑|슈발블랑)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '슈발 블랑',
        canonicalEn: 'Château Cheval Blanc',
        acceptedCanonicalAliases: ['Cheval Blanc', '슈발블랑'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse', 'alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['슈발블랑', '슈발 블랑', 'Cheval Blanc', 'Château Cheval Blanc', 'Chateau Cheval Blanc'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 슈발블랑 as an exact Château Cheval Blanc lookup, not a broad Saint-Émilion / Bordeaux recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 543,
    tier: 'wine_name_lookup',
    query: '오브리옹',
    description: 'Common Korean transliteration exact lookup: Haut-Brion',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(haut\\s*brion|오브리옹)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '오브리옹',
        canonicalEn: 'Château Haut-Brion',
        acceptedCanonicalAliases: ['Haut-Brion', 'Haut Brion'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['오브리옹', 'Haut-Brion', 'Haut Brion', 'Château Haut-Brion', 'Chateau Haut-Brion'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 오브리옹 as an exact Château Haut-Brion lookup, not a broad Bordeaux recommendation. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 544,
    tier: 'wine_name_lookup',
    query: '크루그',
    description: 'Common Korean transliteration exact lookup: Krug',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(krug|크루그)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '크루그',
        canonicalEn: 'Krug',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['크루그', 'Krug'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 크루그 as an exact Krug lookup, not a generic prestige Champagne browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 545,
    tier: 'wine_name_lookup',
    query: '루이로드레 크리스탈',
    description: 'Common Korean no-space transliteration exact SKU lookup: Louis Roederer Cristal',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(louis\\s*roederer|루이\\s*로드레|루이로드레).*(cristal|크리스탈)|(cristal|크리스탈)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '루이 로드레 크리스탈',
        canonicalEn: 'Louis Roederer Cristal',
        acceptedCanonicalAliases: ['루이로드레 크리스탈'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse'],
      },
      expectedToolArgs: [
        {
          tool: 'search_wines',
          argPath: 'query',
          predicate: 'equals_any',
          value: ['루이로드레 크리스탈', '루이 로드레 크리스탈', 'Louis Roederer Cristal'],
        },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 루이로드레 크리스탈 as an exact Louis Roederer Cristal SKU lookup, not a broad Champagne browse. '
        + 'If the live corpus cannot confirm the exact SKU, honest abstention is acceptable.',
    },
  },
  {
    id: 546,
    tier: 'wine_name_lookup',
    query: '떼땅져',
    description: 'Common Korean transliteration exact lookup: Taittinger',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(taittinger|떼땅져|테탕저)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '떼땅져',
        canonicalEn: 'Taittinger',
        acceptedCanonicalAliases: ['테탕저'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['transliteration-variant', 'alias'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['떼땅져', '테탕저', 'Taittinger'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 떼땅져 as an exact Taittinger lookup, not a generic Champagne browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 547,
    tier: 'wine_name_lookup',
    query: '오르넬라이아',
    description: 'Common Korean transliteration exact lookup: Ornellaia',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(ornellaia|오르넬라이아)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '오르넬라이아',
        canonicalEn: 'Ornellaia',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['오르넬라이아', 'Ornellaia'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 오르넬라이아 as an exact Ornellaia lookup rather than a generic Bolgheri / Super Tuscan browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 548,
    tier: 'wine_name_lookup',
    query: '케이머스',
    description: 'Common Korean transliteration exact lookup: Caymus',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(caymus|케이머스)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '케이머스',
        canonicalEn: 'Caymus',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['케이머스', 'Caymus'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 케이머스 as an exact Caymus lookup rather than a generic Napa Cabernet browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 549,
    tier: 'wine_name_lookup',
    query: '펜폴즈 그레인지',
    description: 'Common Korean transliteration exact lookup: Penfolds Grange',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(penfolds|펜폴즈).*(grange|그레인지)|(grange|그레인지)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '펜폴즈 그레인지',
        canonicalEn: 'Penfolds Grange',
        acceptedCanonicalAliases: [],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['펜폴즈 그레인지', 'Penfolds Grange'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 펜폴즈 그레인지 as an exact Penfolds Grange lookup, not a generic Australian Shiraz browse. '
        + 'If the live corpus cannot confirm the exact wine, honest abstention is acceptable.',
    },
  },
  {
    id: 550,
    tier: 'wine_name_lookup',
    query: '루이자도',
    description: 'Common Korean no-space transliteration exact lookup: Louis Jadot',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(louis\\s*jadot|루이\\s*자도|루이자도)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '루이 자도',
        canonicalEn: 'Louis Jadot',
        acceptedCanonicalAliases: ['루이자도'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse'],
      },
      expectedToolArgs: [
        { tool: 'search_wines', argPath: 'query', predicate: 'equals_any', value: ['루이자도', '루이 자도', 'Louis Jadot'] },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 루이자도 as an exact Louis Jadot lookup rather than a generic Burgundy browse. '
        + 'If the live corpus cannot confirm the exact producer or wine, honest abstention is acceptable.',
    },
  },
  {
    id: 551,
    tier: 'wine_name_lookup',
    query: '조셉펠프스 인시그니아',
    description: 'Common Korean transliteration exact SKU lookup: Joseph Phelps Insignia',
    expectation: {
      tools: [{ tool: 'search_wines' }],
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      answerMustMatch: ['(joseph\\s*phelps|조셉\\s*펠프스|조셉펠프스).*(insignia|인시그니아)|(insignia|인시그니아)'],
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        canonicalKo: '조셉 펠프스 인시그니아',
        canonicalEn: 'Joseph Phelps Insignia',
        acceptedCanonicalAliases: ['조셉펠프스 인시그니아'],
        matchPolicy: 'exact_entity',
        allowAliasMatch: true,
        allowSpaceNormalization: true,
        allowVariantTransliteration: true,
        phenomena: ['canonical-ko', 'space-collapse'],
      },
      expectedToolArgs: [
        {
          tool: 'search_wines',
          argPath: 'query',
          predicate: 'equals_any',
          value: ['조셉펠프스 인시그니아', '조셉 펠프스 인시그니아', 'Joseph Phelps Insignia'],
        },
        { tool: 'search_wines', argPath: 'retrieval_mode', predicate: 'equals', value: 'entity' },
      ],
      rubric:
        'Must treat 조셉펠프스 인시그니아 as an exact Joseph Phelps Insignia lookup, not a generic Napa Cabernet browse. '
        + 'If the live corpus cannot confirm the exact SKU, honest abstention is acceptable.',
    },
  },
  {
    id: 552,
    tier: 'wine_name_lookup',
    query: '마고',
    description: 'Hard negative: underspecified token must not force exact Château Margaux resolution',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
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
        mustNotReturnCanonicalAliases: ['Château Margaux', 'Chateau Margaux', '샤또 마고'],
        phenomena: ['underspecified'],
      },
      rubric:
        'Must not force "마고" into an exact Château Margaux resolution. '
        + 'It should ask for clarification or abstain instead of pretending the exact wine is known.',
    },
  },
  {
    id: 553,
    tier: 'wine_name_lookup',
    query: '모엣 로제',
    description: 'Hard negative: brand-family mention must not force Rosé Impérial SKU',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        canonicalKo: '모엣 샹동 로제 임페리얼',
        canonicalEn: 'Moët & Chandon Rosé Impérial',
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Moët & Chandon Rosé Impérial', 'Moet Chandon Rose Imperial', '모엣 샹동 로제 임페리얼'],
        phenomena: ['brand-family-ambiguous'],
      },
      rubric:
        'Must not collapse the broad family phrase "모엣 로제" into the exact Rosé Impérial SKU without explicit alias evidence. '
        + 'Clarification or honest abstention is correct.',
    },
  },
  {
    id: 554,
    tier: 'wine_name_lookup',
    query: '샹동 로제',
    description: 'Hard negative: nearby-brand mention must not force Moët & Chandon Rosé Impérial',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        canonicalKo: '모엣 샹동 로제 임페리얼',
        canonicalEn: 'Moët & Chandon Rosé Impérial',
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Moët & Chandon Rosé Impérial', 'Moet Chandon Rose Imperial', '모엣 샹동 로제 임페리얼'],
        phenomena: ['wrong-brand-nearby'],
      },
      rubric:
        'Must not map the nearby-brand phrase "샹동 로제" to Moët & Chandon Rosé Impérial. '
        + 'This should fail closed or ask the user which Chandon / rosé label they mean.',
    },
  },
  {
    id: 555,
    tier: 'wine_name_lookup',
    query: '볼게리 레드',
    description: 'Hard negative: category / region phrase must not force exact Super Tuscan entity',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
      exactLookup: {
        locale: 'ko-KR',
        domain: 'wine',
        expectedEntityId: null,
        matchPolicy: 'must_not_exact_match',
        allowAliasMatch: false,
        allowSpaceNormalization: true,
        allowVariantTransliteration: false,
        mustNotReturnCanonicalAliases: ['Sassicaia', 'Ornellaia', '사시까이아', '오르넬라이아'],
        phenomena: ['category-not-entity'],
      },
      rubric:
        'Must not force the category phrase "볼게리 레드" into an exact Sassicaia or Ornellaia entity. '
        + 'It can browse Bolgheri reds, but exact entity resolution is not justified here.',
    },
  },
  {
    id: 556,
    tier: 'wine_name_lookup',
    query: '페트루스',
    description: 'Policy-pending Koreanized Latin variant: alias hit or fail closed',
    expectation: {
      maxSteps: 2,
      maxDurationMs: 40_000,
      maxTotalTokens: 7_000,
      judgeRequired: true,
      allowHonestNoEvidenceAbstention: true,
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
        phenomena: ['transliteration-variant', 'alias'],
      },
      rubric:
        'For "페트루스", either resolve cleanly to Pétrus via an accepted alias path or fail closed honestly. '
        + 'It must not drift to a different Bordeaux exact label.',
    },
  },
  ...TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIOS,
];

/**
 * Scenario ID layout for this module. Every range is half-open `[start, endExclusive)`
 * and derived from the literal `id:` fields in {@link ROBUSTNESS_SCENARIOS} above.
 *
 * Maintaining these as named ranges avoids `no-magic-numbers` violations on the
 * sets below and keeps the boundaries auditable from a single block.
 *
 * Inherited core IDs (202/204/209) live in `scenarios.coverage.ts` and are
 * surfaced here as a shared transliteration core anchor.
 */
const MESSY_QUERY_ROBUSTNESS_ID_START = 520;
const MESSY_QUERY_ROBUSTNESS_ID_END_EXCLUSIVE = 525; // covers 520..524 (5 scenarios)

const TRANSLITERATION_CORE_LOCAL_ID_START = 530;
const TRANSLITERATION_CORE_LOCAL_ID_END_EXCLUSIVE = 552; // covers 530..551 (22 scenarios)

const TRANSLITERATION_HARD_NEGATIVE_ID_START = 552;
const TRANSLITERATION_HARD_NEGATIVE_ID_END_EXCLUSIVE = 556; // covers 552..555 (4 scenarios)

const TRANSLITERATION_POLICY_PENDING_ID_START = 556;
const TRANSLITERATION_POLICY_PENDING_ID_END_EXCLUSIVE = 557; // covers 556 (1 scenario)

/**
 * IDs inherited from `scenarios.coverage.ts` that anchor the transliteration core.
 *
 * Each constant names the original `id:` literal at its definition site in
 * `scenarios.coverage.ts`. Listing them out (instead of an opaque numeric
 * literal array) keeps the linkage explicit and satisfies `no-magic-numbers`.
 */
const SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_A = 202;
const SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_B = 204;
const SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_C = 209;

const TRANSLITERATION_CORE_INHERITED_IDS: readonly number[] = [
  SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_A,
  SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_B,
  SCENARIO_COVERAGE_TRANSLITERATION_ANCHOR_ID_C,
] as const;

function rangeToSet(startInclusive: number, endExclusive: number): ReadonlySet<number> {
  const ids: number[] = [];
  for (let id = startInclusive; id < endExclusive; id += 1) {
    ids.push(id);
  }
  return new Set(ids);
}

export const MESSY_QUERY_ROBUSTNESS_SCENARIO_IDS: ReadonlySet<number> = rangeToSet(
  MESSY_QUERY_ROBUSTNESS_ID_START,
  MESSY_QUERY_ROBUSTNESS_ID_END_EXCLUSIVE,
);

export const TRANSLITERATION_EXACT_LOOKUP_CORE_SCENARIO_IDS: ReadonlySet<number> = new Set([
  ...TRANSLITERATION_CORE_INHERITED_IDS,
  ...rangeToSet(TRANSLITERATION_CORE_LOCAL_ID_START, TRANSLITERATION_CORE_LOCAL_ID_END_EXCLUSIVE),
]);

export const TRANSLITERATION_EXACT_LOOKUP_HARD_NEGATIVE_SCENARIO_IDS: ReadonlySet<number> = rangeToSet(
  TRANSLITERATION_HARD_NEGATIVE_ID_START,
  TRANSLITERATION_HARD_NEGATIVE_ID_END_EXCLUSIVE,
);

export const TRANSLITERATION_EXACT_LOOKUP_POLICY_PENDING_SCENARIO_IDS: ReadonlySet<number> = rangeToSet(
  TRANSLITERATION_POLICY_PENDING_ID_START,
  TRANSLITERATION_POLICY_PENDING_ID_END_EXCLUSIVE,
);

export const TRANSLITERATION_EXACT_LOOKUP_SCENARIO_IDS: ReadonlySet<number> = new Set([
  ...TRANSLITERATION_EXACT_LOOKUP_CORE_SCENARIO_IDS,
  ...TRANSLITERATION_EXACT_LOOKUP_HARD_NEGATIVE_SCENARIO_IDS,
]);

export {
  TRANSLITERATION_EXACT_LOOKUP_LARGE_HARD_NEGATIVE_SCENARIO_IDS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_POSITIVE_SCENARIO_IDS,
  TRANSLITERATION_EXACT_LOOKUP_LARGE_SCENARIO_IDS,
};
