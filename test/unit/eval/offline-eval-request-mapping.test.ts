import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import {
  applyResolvedLegacyEntityIdsToGoldenQueries,
  buildEvalSearchRequestBody,
  collectLegacyEvalEntityIdRefs,
  resolveEvalRetrievalMode,
} from '../../../scripts/eval/run-offline-eval.js';

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
  it('routes exact entity eval rows through the entity family', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: 'entity_lookup',
    }));

    expect(body.options.mode).toBe('entity');
    expect(body.retrieval_mode).toBe('entity');
  });

  it('routes ambiguous entity eval rows through the entity family', () => {
    const body = buildEvalSearchRequestBody(makeGoldenQuery({
      retrieval_mode: 'entity_resolution',
      query_class: 'short_entity',
      scenario: 'B',
    }));

    expect(body.options.mode).toBe('entity');
    expect(body.retrieval_mode).toBe('entity');
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

  it('infers similar-items retrieval mode from similar_compare rows with no explicit label', () => {
    const query = makeGoldenQuery({
      retrieval_mode: undefined,
      query_class: 'similar_compare',
      scenario: 'F',
      query: 'wines similar to Opus One',
    });

    expect(resolveEvalRetrievalMode(query)).toBe('similar_items');
    expect(buildEvalSearchRequestBody(query).retrieval_mode).toBe('mixed');
  });

  it('keeps specialized exploratory retrieval modes on the hybrid family', () => {
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

  it('infers entity family for exact-entity rows with no explicit retrieval label', () => {
    const query = makeGoldenQuery({
      retrieval_mode: undefined,
      query_class: 'exact_entity',
      scenario: 'A',
      query: 'Opus One 2018',
    });

    expect(resolveEvalRetrievalMode(query)).toBe('entity_lookup');
    expect(buildEvalSearchRequestBody(query).retrieval_mode).toBe('entity');
  });
});

describe('offline eval legacy entity-id canonicalization', () => {
  it('collects legacy ids from both relevant judgments and expected entity ids', () => {
    const refs = collectLegacyEvalEntityIdRefs([
      makeGoldenQuery({
        retrieval_labels: {
          relevant: [{ entity_id: 'vivino-123', grade: 3 }],
        },
        decision_labels: {
          expected_decision_status: 'resolved',
          expected_entity_id: 'vivino-456',
          ambiguity_expected: false,
          requires_abstain: false,
        },
        leakage_keys: {
          entity_id: 'vivino-789',
          query_template_id: 'template-1',
          generation_run_id: 'run-1',
          alias_cluster_id: 'cluster-1',
        },
      }),
    ]);

    expect(refs).toEqual([
      { caseId: 'q-1:relevant', entityId: 'vivino-123' },
      { caseId: 'q-1:expected', entityId: 'vivino-456' },
    ]);
  });

  it('canonicalizes relevant, expected, and leakage ids through the resolved mapping', () => {
    const [canonicalized] = applyResolvedLegacyEntityIdsToGoldenQueries([
      makeGoldenQuery({
        retrieval_labels: {
          relevant: [{ entity_id: 'vivino-123', grade: 3 }],
        },
        decision_labels: {
          expected_decision_status: 'resolved',
          expected_entity_id: 'vivino-456',
          ambiguity_expected: false,
          requires_abstain: false,
        },
        leakage_keys: {
          entity_id: 'vivino-789',
          query_template_id: 'template-1',
          generation_run_id: 'run-1',
          alias_cluster_id: 'cluster-1',
        },
      }),
    ], new Map([
      ['vivino-123', 'wine-ce-123'],
      ['vivino-456', 'wine-ce-456'],
      ['vivino-789', 'wine-ce-789'],
    ]));

    expect(canonicalized?.retrieval_labels.relevant[0]?.entity_id).toBe('wine-ce-123');
    expect(canonicalized?.decision_labels.expected_entity_id).toBe('wine-ce-456');
    expect(canonicalized?.leakage_keys.entity_id).toBe('wine-ce-789');
  });
});
