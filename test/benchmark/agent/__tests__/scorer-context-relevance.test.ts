import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import {
  makeScenario,
  makeExecution,
  makeEvidenceFrame,
  tool,
} from './__helpers__/scorer-test-helpers.js';

describe('RAGAS Context Relevance', () => {
  it('returns null when no observations', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({ observations: [] }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeNull();
  });

  it('scores frame-only executions without requiring raw observations', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '바롤로', canonical: 'Barolo', type: 'appellation' }],
      }),
      makeExecution({
        observations: [],
        evidenceFrames: [
          makeEvidenceFrame({
            structuredOutput: {
              kind: 'search_result_set',
              resultSet: [{
                entity: {
                  entityId: 'barolo-1',
                  canonicalLabel: 'Benchmark Barolo',
                  type: 'wine',
                  appellation: 'Barolo',
                },
                relevanceScore: 0.82,
                match: {
                  matchType: 'semantic',
                  scoreComponents: {
                    lexical: 0.2,
                    semantic: 0.8,
                    attribute: 0.5,
                    popularity: 0.1,
                  },
                },
                constraints: { matched: [], unmet: [], inferred: [] },
                uncertainty: { missingInfo: [], approximationUsed: false },
                evidenceItems: [{ type: 'entity', source: 'fixture', contribution: 'matched appellation', strength: 'high', provenance: 'fixture' }],
              }],
              resultCount: 1,
            },
          }),
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBe(1);
  });

  it('returns null when no structured constraints', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ observations: ['Found: Wine A | vintage: 2019'] }),
      undefined,
    );
    // No priceBandKrw, vintageRange, drinkingWindowStatus, structured tool
    // fields, or expectedEntities signal → not measurable.
    expect(r.scores.contextRelevance).toBeNull();
  });

  it('treats explicit no-evidence abstention scenarios as unmeasurable instead of failed context relevance', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 2,
        allowHonestNoEvidenceAbstention: true,
        expectedConstraints: {
          hard: [
            { attribute: 'region', operator: '=', value: 'Beaujolais' },
          ],
          soft: [],
          inferred: [],
        },
      }, {
        query: '보졸레누보 올해꺼 나왔는지 확실한 근거 없으면 추정하지 말고 말해줘',
        goldenKeywords: ['beaujolais', 'nouveau'],
      }),
      makeExecution({
        observations: [
          '[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다. 검색어: "보졸레누보".',
        ],
        answer: '확실한 근거가 없어서 올해 보졸레 누보가 나왔는지 확인할 수 없습니다. 추정해서 말하지 않겠습니다.',
      }),
      1,
      1,
    );

    expect(r.scores.contextRelevance).toBeNull();
    expect(r.scores.contextRecall).toBeNull();
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_RELEVANCE_SKIPPED_NO_EVIDENCE_ABSTENTION')).toBe(true);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_RECALL_SKIPPED_NO_EVIDENCE_ABSTENTION')).toBe(true);
  });

  it('still scores context relevance normally when no-evidence abstention is not explicitly allowed', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 2,
        expectedConstraints: {
          hard: [
            { attribute: 'region', operator: '=', value: 'Beaujolais' },
          ],
          soft: [],
          inferred: [],
        },
      }, {
        query: '보졸레누보 올해꺼 나왔는지',
        goldenKeywords: ['beaujolais', 'nouveau'],
      }),
      makeExecution({
        observations: [
          '[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다. 검색어: "보졸레누보".',
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBe(0);
    expect(r.scores.contextRecall).toBe(0);
  });

  it('vintageRange: passes when observation contains in-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2019 | region: Napa'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('vintageRange: fails when observation contains out-of-range year', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2018, max: 2020 } }),
      makeExecution({
        observations: ['Found: Wine A | vintage: 2015 | region: Napa'],
      }),
      undefined,
    );
    // P1-B fix: vintage is a hard constraint — out-of-range → CONTEXT_HARD_CONSTRAINT_FAILED
    // (not CONTEXT_RELEVANCE_LOW), and contextRelevance collapses to 0.
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(true);
    expect(r.scores.contextRelevance).toBe(0);
  });

  it('drinkingWindowStatus: passes when keywords match', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, drinkingWindowStatus: 'now' }),
      makeExecution({
        observations: ['Wine A: currently drinkable, peak 2024-2028'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('expected entity alignment: passes when canonical entity evidence is present', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '바롤로', canonical: 'Barolo', type: 'appellation' }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"바롤로"}')],
        observations: ['Found: Barolo 2018 | appellation: Barolo | producer: Benchmark Winery'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('expected entity alignment: supports Korean surface to English canonical evidence', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '레드', canonical: 'red', type: 'wine_type' }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"레드 와인 추천"}')],
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"red-1","canonical_label":"Benchmark Red","wine_type":"red","style":"red"}]}',
        ],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });

  it('expected entity alignment: fails when structured wine_type passes but entity axis is absent', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '바롤로', canonical: 'Barolo', type: 'appellation' }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"바롤로","wine_type":"red"}')],
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"random-red-1","canonical_label":"Random Red Wine","wine_type":"red","style":"red","producer":"Benchmark Winery"}]}',
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBeLessThan(1);
    const diagnostic = r.diagnostics?.find((d) => d.code === 'CONTEXT_RELEVANCE_LOW');
    expect(r.scores.contextRelevance).toBe(0.5);
    expect(diagnostic?.message).toContain('raw_alignment passed 0/1');
    expect(diagnostic?.message).toContain('structured passed 1/1');
    expect(diagnostic?.message).toContain('expected_entity_appellation_Barolo');
  });

  it('expected entity alignment: cross-lingual Korean query can be measured via canonical entities', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [
          { surface: '이탈리아', canonical: 'Italy', type: 'country' },
          { surface: '레드', canonical: 'red', type: 'wine_type' },
        ],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"이탈리아 레드 평점 좋고 지금 마실 수 있는"}')],
        observations: ['Found 5 results: 1. Barolo 2018 (id: wine-001) | producer: Giacomo Conterno | region: Piedmont, Italy | grapes: Nebbiolo | price: 80000-120000'],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).not.toBeNull();
  });

  it('does not fall back to regex observations when frame output has no evidence records', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '오퍼스 원', canonical: 'Opus One', type: 'appellation' }],
      }),
      makeExecution({
        observations: ['Found 1 result: Opus One 2018 | appellation: Opus One'],
        evidenceFrames: [
          makeEvidenceFrame({
            structuredOutput: { kind: 'no_op', reason: 'no structured evidence' },
          }),
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBeNull();
    expect(r.diagnostics?.some((d) => d.message.includes('expected_entity_appellation_Opus One'))).not.toBe(true);
  });

  it('uses structured tool input and grounding evidence for context relevance', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [
          tool('search_wines', '{"query":"달달하고 도수 낮은 선물용","styles":["sweet"],"max_alcohol_pct":12}'),
        ],
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"sweet-1","canonical_label":"Sweet Dessert Wine","wine_type":"dessert","style":"sweet","sweetness":0.9}]}',
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBe(0.5);
    expect(r.diagnostics?.some((d) => d.message.includes('tool_alcohol_pct_lte_12'))).toBe(true);
  });

  it('passes context relevance when structured wine_type and expected entity are both present', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '바롤로', canonical: 'Barolo', type: 'appellation' }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"바롤로","wine_type":"red"}')],
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"barolo-2018","canonical_label":"Benchmark Barolo 2018","appellation":"Barolo","wine_type":"red","style":"red","producer":"Benchmark Winery"}]}',
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBe(1);
  });

  it('keeps raw entity alignment independent from multiple structured passes', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        expectedEntities: [{ surface: '바롤로', canonical: 'Barolo', type: 'appellation' }],
        expectedConstraints: {
          hard: [
            {
              attribute: 'wine_type',
              operator: '=',
              value: 'red',
              source_phrase: '레드',
              confidence: 1,
            },
            {
              attribute: 'country',
              operator: '=',
              value: 'Italy',
              source_phrase: '이탈리아',
              confidence: 1,
            },
          ],
          soft: [],
          inferred: [],
        },
      }),
      makeExecution({
        toolsUsed: [
          tool('search_wines', '{"query":"바롤로","wine_type":"red","country":"Italy","styles":["dry"]}'),
        ],
        observations: [
          'Found 1 result\nGROUNDING_JSON: {"query_type":"search","total_results":1,"wines":[{"entity_id":"random-red-1","canonical_label":"Random Red Wine","wine_type":"red","style":"dry","country":"Italy","producer":"Benchmark Winery"}]}',
        ],
      }),
      undefined,
    );

    expect(r.scores.contextRelevance).toBe(0.5);
    const diagnostic = r.diagnostics?.find((d) => d.code === 'CONTEXT_RELEVANCE_LOW');
    expect(diagnostic?.message).toContain('raw_alignment passed 0/1');
    expect(diagnostic?.message).toContain('structured passed 5/5');
  });

  it('returns null when no structured or expected-entity context signal exists', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Italian red high rating"}')],
        observations: ['Found 2 results: 1. Barolo Nebbiolo 2018 | region: Piedmont, Italy | grapes: Nebbiolo'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// RAGAS Context Recall (canonical-label keyword overlap — v3)
// ─────────────────────────────────────────────────────────────────────
// v3 breaking change: goldenEntityIds (slug-based) replaced by goldenKeywords
// (canonical-label fragments). Observations may include "(id: opus-one-2018)" style ids.
// so keyword "opus one" matches; slug "opus-one-2018" never matched.


describe('P1-B regression — contextRelevance hard constraint collapse', () => {
  it('price out-of-range → soft penalty (not critical)', () => {
    // Price is a soft constraint (search pipeline has no real price filter).
    // Out-of-range price docks contextRelevance but does NOT trigger critical failure.
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        priceBandKrw: { min: 50_000, max: 100_000 },
        expectedEntities: [
          { surface: 'Cabernet', canonical: 'Cabernet Sauvignon', type: 'grape_primary' },
        ],
      }),
      makeExecution({
        observations: ['Wine A: 200,000원 | Napa Cabernet 2019 | grapes: Cabernet Sauvignon | score: 95'],
        toolsUsed: [tool('search_wines', JSON.stringify({ query: 'Cabernet Napa' }))],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeLessThan(1);
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('vintage out-of-range → score 0', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 2015, max: 2020 } }),
      makeExecution({
        observations: ['Wine B: 2010 Burgundy Pinot Noir | 80,000원'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBe(0);
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(true);
  });

  it('price in-range + vintage in-range → partial score from soft checks only', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        priceBandKrw: { min: 50_000, max: 150_000 },
        vintageRange: { min: 2015, max: 2020 },
      }),
      makeExecution({
        observations: ['Wine C: 2018 Napa Cabernet | 80,000원'],
        toolsUsed: [tool('search_wines', JSON.stringify({ query: 'Cabernet Napa 2018' }))],
      }),
      undefined,
    );
    // Both hard constraints pass → score > 0
    expect(r.scores.contextRelevance).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P2 regression: extractKoreanPrices €/£ support
// ─────────────────────────────────────────────────────────────────────

