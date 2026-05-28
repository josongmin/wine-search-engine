import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import {
  summarizeReleaseCorpusGovernance,
  validateReleaseCorpusGovernance,
} from '../../../scripts/eval/release-corpus-governance.js';

function makeQuery(overrides: Partial<GoldenQuery> = {}): GoldenQuery {
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
      query_template_id: 'tmpl-1',
      generation_run_id: 'run-1',
      alias_cluster_id: 'alias-1',
    },
    annotation_tier: 'silver',
    annotated_by: ['reviewer-1'],
    release_gate_eligible: true,
    created_at: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('release-corpus-governance', () => {
  it('summarizes label, slice, query-class, language, and entity share mixes', () => {
    const summary = summarizeReleaseCorpusGovernance([
      makeQuery(),
      makeQuery({
        qid: 'q-2',
        query: '상큼한 화이트 와인 추천',
        query_class: 'semantic_preference',
        scenario: 'D',
        language: 'ko',
        decision_labels: {
          expected_decision_status: 'resolved',
          expected_entity_id: 'wine-2',
          ambiguity_expected: false,
          requires_abstain: false,
        },
        leakage_keys: {
          entity_id: 'wine-2',
          query_template_id: 'tmpl-2',
          generation_run_id: 'run-2',
          alias_cluster_id: 'alias-2',
        },
      }),
    ]);

    expect(summary.queryCount).toBe(2);
    expect(summary.labelTierMix).toEqual({ silver: 2 });
    expect(summary.sliceMix).toEqual({ A: 1, D: 1 });
    expect(summary.queryClassMix).toEqual({ exact_entity: 1, semantic_preference: 1 });
    expect(summary.languageMix).toEqual({ en: 1, ko: 1 });
    expect(summary.entityShareTop[0]).toEqual(expect.objectContaining({ share: 0.5 }));
  });

  it('rejects bronze rows in release corpora', () => {
    expect(() => validateReleaseCorpusGovernance([
      makeQuery({ annotation_tier: 'bronze' }),
      makeQuery({ qid: 'q-2' }),
    ])).toThrow(/bronze-tier rows/);
  });

  it('rejects entity concentration above the 3 percent cap', () => {
    const queries = Array.from({ length: 40 }, (_, index) =>
      makeQuery({
        qid: `q-${index + 1}`,
        decision_labels: {
          expected_decision_status: 'resolved',
          expected_entity_id: index < 2 ? 'wine-hot' : `wine-${index + 1}`,
          ambiguity_expected: false,
          requires_abstain: false,
        },
        leakage_keys: {
          entity_id: index < 2 ? 'wine-hot' : `wine-${index + 1}`,
          query_template_id: `tmpl-${index + 1}`,
          generation_run_id: `run-${index + 1}`,
          alias_cluster_id: `alias-${index + 1}`,
        },
      }),
    );

    expect(() => validateReleaseCorpusGovernance(queries)).toThrow(/entity cap exceeded/);
  });

  it('rejects rows whose declared language drifts from the query surface', () => {
    expect(() => validateReleaseCorpusGovernance([
      makeQuery({ language: 'ko' }),
      makeQuery({ qid: 'q-2' }),
    ])).toThrow(/query language labels drift from query surface/);
  });

  it('rejects exact entity rows without a vintage token', () => {
    expect(() => validateReleaseCorpusGovernance([
      makeQuery({ query: 'Anne Gros' }),
      makeQuery({ qid: 'q-2' }),
    ])).toThrow(/exact_entity rows missing vintage token/);
  });
});
