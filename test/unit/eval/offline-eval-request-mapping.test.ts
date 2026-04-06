import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import { buildEvalSearchRequestBody } from '../../../scripts/eval/run-offline-eval.js';

function makeGoldenQuery(
  overrides: Partial<GoldenQuery> = {},
): GoldenQuery {
  return {
    qid: 'q-1',
    query: 'Opus One 2018',
    query_class: 'exact_entity',
    scenario: 'A',
    language: 'en',
    retrieval_labels: {
      relevant: [{ entity_id: 'wine-1', grade: 3 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: 'wine-1',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: 'wine-1',
      query_template_id: 'template-1',
      generation_run_id: 'run-1',
      alias_cluster_id: 'cluster-1',
    },
    annotation_tier: 'bronze',
    annotated_by: ['test'],
    release_gate_eligible: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildEvalSearchRequestBody', () => {
  it('keeps entity-oriented eval rows on the ranked-search family used by offline smoke baselines', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: 'entity_lookup',
    }));

    expect(body.options.mode).toBe('hybrid');
    expect(body.retrieval_mode).toBe('hybrid');
  });

  it('routes similar-items eval rows through mixed search', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: 'similar_items',
      query_class: 'similar_compare',
      scenario: 'F',
    }));

    expect(body.options.mode).toBe('mixed');
    expect(body.retrieval_mode).toBe('mixed');
  });

  it('keeps specialized hybrid-like retrieval modes on the hybrid family', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: 'producer_browse',
      query_class: 'catalog_browse',
      scenario: 'G',
    }));

    expect(body.options.mode).toBe('hybrid');
    expect(body.retrieval_mode).toBe('hybrid');
  });

  it('defaults to hybrid when dataset row has no explicit retrieval label', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: undefined,
      query_class: 'semantic_preference',
      scenario: 'C',
    }));

    expect(body.options.mode).toBe('hybrid');
    expect(body.retrieval_mode).toBe('hybrid');
  });
});
