import { describe, expect, it, vi } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import {
  applyResolvedHumanGoldRuntimeEntityIds,
  assertHumanGoldRuntimeCoverage,
  collectHumanGoldCatalogRows,
  resolveHumanGoldRuntimeEntityIds,
  summarizeHumanGoldRuntimeCoverage,
} from '../../../scripts/eval/embedding-sensitive-human-gold-runtime-corpus.js';

function makeGoldenQuery(
  overrides: Partial<GoldenQuery> = {},
): GoldenQuery {
  return {
    qid: 'q-1',
    query: 'Opus One 2018',
    query_class: 'similar_compare',
    scenario: 'F',
    language: 'en',
    retrieval_labels: {
      relevant: [{ entity_id: 'w-opus-one-2018', grade: 3 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: 'w-sassicaia-2018',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: 'w-chateau-margaux-2015',
      query_template_id: 'embedding_sensitive_human_gold_similar_compare_v1',
      generation_run_id: 'embedding-sensitive-human-gold-v1',
      alias_cluster_id: 'human-gold-scenario-7',
    },
    annotation_tier: 'gate',
    annotated_by: ['human_gold:scenario-7'],
    release_gate_eligible: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('embedding-sensitive human-gold runtime corpus', () => {
  it('collects benchmark ids from relevant, expected, and leakage labels', () => {
    const rows = collectHumanGoldCatalogRows({
      queries: [
        makeGoldenQuery(),
        makeGoldenQuery({
          qid: 'q-2',
          retrieval_labels: {
            relevant: [{ entity_id: 'w-opus-one-2018', grade: 2 }],
          },
          decision_labels: {
            expected_decision_status: 'resolved',
            expected_entity_id: 'w-tignanello-2019',
            ambiguity_expected: false,
            requires_abstain: false,
          },
          leakage_keys: {
            entity_id: 'w-chateau-margaux-2015',
            query_template_id: 'template-2',
            generation_run_id: 'run-2',
            alias_cluster_id: 'cluster-2',
          },
        }),
      ],
      catalogLookup: new Map([
        ['w-opus-one-2018', { canonicalLabel: 'Opus One 2018' }],
        ['w-sassicaia-2018', { canonicalLabel: 'Tenuta San Guido Sassicaia 2018' }],
        ['w-chateau-margaux-2015', { canonicalLabel: 'Chateau Margaux 2015' }],
        ['w-tignanello-2019', { canonicalLabel: 'Antinori Tignanello 2019' }],
      ]),
    });

    expect(rows).toEqual([
      {
        benchmarkId: 'w-chateau-margaux-2015',
        canonicalLabel: 'Chateau Margaux 2015',
        strippedRuntimeId: 'chateau-margaux-2015',
      },
      {
        benchmarkId: 'w-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        strippedRuntimeId: 'opus-one-2018',
      },
      {
        benchmarkId: 'w-sassicaia-2018',
        canonicalLabel: 'Tenuta San Guido Sassicaia 2018',
        strippedRuntimeId: 'sassicaia-2018',
      },
      {
        benchmarkId: 'w-tignanello-2019',
        canonicalLabel: 'Antinori Tignanello 2019',
        strippedRuntimeId: 'tignanello-2019',
      },
    ]);
  });

  it('resolves direct ids, stripped benchmark prefixes, and exact canonical labels with precedence', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          benchmark_id: 'w-opus-one-2018',
          entity_id: 'opus-one-2018',
          match_authority: 'strip_benchmark_prefix',
          precedence: 2,
        },
        {
          benchmark_id: 'w-opus-one-2018',
          entity_id: 'opus-one-2018',
          match_authority: 'exact_canonical_label',
          precedence: 3,
        },
        {
          benchmark_id: 'sassicaia-2018',
          entity_id: 'sassicaia-2018',
          match_authority: 'direct_public_id',
          precedence: 1,
        },
      ],
    });

    const resolution = await resolveHumanGoldRuntimeEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [
        {
          benchmarkId: 'w-opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          strippedRuntimeId: 'opus-one-2018',
        },
        {
          benchmarkId: 'sassicaia-2018',
          canonicalLabel: 'Tenuta San Guido Sassicaia 2018',
        },
        {
          benchmarkId: 'w-missing-2019',
          canonicalLabel: 'Missing 2019',
          strippedRuntimeId: 'missing-2019',
        },
      ],
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(`'strip_benchmark_prefix'::text`),
      [
        'search-snapshot:v1:test',
        expect.any(String),
      ],
    );
    expect(resolution.resolvedIds.get('w-opus-one-2018')).toBe('opus-one-2018');
    expect(resolution.matchedAuthorities.get('w-opus-one-2018')).toBe('strip_benchmark_prefix');
    expect(resolution.resolvedIds.get('sassicaia-2018')).toBe('sassicaia-2018');
    expect(resolution.matchedAuthorities.get('sassicaia-2018')).toBe('direct_public_id');
    expect(resolution.missingBenchmarkIds).toEqual(['w-missing-2019']);
  });

  it('fails closed when one benchmark id maps to multiple runtime entity ids', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          benchmark_id: 'w-opus-one-2018',
          entity_id: 'opus-one-2018',
          match_authority: 'strip_benchmark_prefix',
          precedence: 2,
        },
        {
          benchmark_id: 'w-opus-one-2018',
          entity_id: 'opus-one-library-2018',
          match_authority: 'exact_canonical_label',
          precedence: 3,
        },
      ],
    });

    await expect(resolveHumanGoldRuntimeEntityIds(
      { query } as never,
      'search-snapshot:v1:test',
      [{
        benchmarkId: 'w-opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        strippedRuntimeId: 'opus-one-2018',
      }],
    )).rejects.toThrow(/maps to multiple runtime entity ids/);
  });

  it('summarizes and fails closed on partial runtime coverage', () => {
    const queries = [
      makeGoldenQuery(),
      makeGoldenQuery({
        qid: 'q-2',
        retrieval_labels: {
          relevant: [{ entity_id: 'w-opus-one-2018', grade: 3 }],
        },
        decision_labels: {
          expected_decision_status: 'resolved',
          expected_entity_id: 'w-opus-one-2018',
          ambiguity_expected: false,
          requires_abstain: false,
        },
        leakage_keys: {
          entity_id: 'w-opus-one-2018',
          query_template_id: 'template-2',
          generation_run_id: 'run-2',
          alias_cluster_id: 'cluster-2',
        },
      }),
    ];
    const summary = summarizeHumanGoldRuntimeCoverage({
      queries,
      snapshotId: 'search-snapshot:v1:test',
      resolution: {
        resolvedIds: new Map([
          ['w-opus-one-2018', 'opus-one-2018'],
        ]),
        matchedAuthorities: new Map([
          ['w-opus-one-2018', 'strip_benchmark_prefix'],
        ]),
        missingBenchmarkIds: ['w-sassicaia-2018', 'w-chateau-margaux-2015'],
      },
    });

    expect(summary.mappedBenchmarkIdCount).toBe(1);
    expect(summary.benchmarkIdCount).toBe(3);
    expect(summary.fullyCoveredQueryCount).toBe(1);
    expect(summary.totalQueryCount).toBe(2);
    expect(summary.uncoveredQueries).toEqual([
      {
        qid: 'q-1',
        missingEntityIds: ['w-sassicaia-2018', 'w-chateau-margaux-2015'],
      },
    ]);
    expect(() => assertHumanGoldRuntimeCoverage(summary)).toThrow(/mapped 1\/3 benchmark ids/);
  });

  it('rewrites the corpus to runtime entity ids after full coverage', () => {
    const [rewritten] = applyResolvedHumanGoldRuntimeEntityIds(
      [makeGoldenQuery()],
      new Map([
        ['w-opus-one-2018', 'opus-one-2018'],
        ['w-sassicaia-2018', 'sassicaia-2018'],
        ['w-chateau-margaux-2015', 'chateau-margaux-2015'],
      ]),
    );

    expect(rewritten?.retrieval_labels.relevant[0]?.entity_id).toBe('opus-one-2018');
    expect(rewritten?.decision_labels.expected_entity_id).toBe('sassicaia-2018');
    expect(rewritten?.leakage_keys.entity_id).toBe('chateau-margaux-2015');
  });
});
