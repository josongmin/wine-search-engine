import { describe, expect, it } from 'vitest';
import {
  assignLookupV2StretchQids,
  summarizeLookupV2StretchCorpus,
} from '../../../scripts/eval/lookup-v2-stretch-corpus.js';

describe('lookup-v2-stretch-corpus helpers', () => {
  it('assigns deterministic qids after the current prefix maximum', () => {
    const assigned = assignLookupV2StretchQids({
      existingRows: [
        {
          qid: 'elv2-kry-005',
          query: 'existing',
          expected_status: 'resolved',
          expected_entity_hint: 'foo',
          class: 'realworld_exact_vintage',
          note: 'existing row',
        },
      ],
      candidateRows: [
        {
          query: 'new one',
          expected_status: 'resolved',
          expected_entity_hint: 'bar',
          class: 'realworld_exact_vintage',
          note: 'candidate one',
        },
        {
          query: 'new two',
          expected_status: 'failed',
          class: 'realworld_adversarial_no_match',
          note: 'candidate two',
        },
      ],
      qidPrefix: 'kry',
    });

    expect(assigned.map((row) => row.qid)).toEqual([
      'elv2-kry-006',
      'elv2-kry-007',
    ]);
  });

  it('summarizes entity vs discovery mix and qid prefixes', () => {
    const summary = summarizeLookupV2StretchCorpus([
      {
        qid: 'elv2-kry-001',
        query: '오푸스원 2018',
        expected_status: 'resolved',
        expected_entity_hint: 'opus one',
        class: 'realworld_exact_vintage',
        note: 'resolved',
      },
      {
        qid: 'elv2-kry-002',
        query: '집들이 와인 추천',
        expected_status: 'redirect_discovery',
        class: 'realworld_occasion_recommendation',
        note: 'redirect',
      },
    ]);

    expect(summary.totalRows).toBe(2);
    expect(summary.entityRows).toBe(1);
    expect(summary.discoveryRows).toBe(1);
    expect(summary.statusCounts.resolved).toBe(1);
    expect(summary.statusCounts.redirect_discovery).toBe(1);
    expect(summary.qidPrefixes.kry).toBe(2);
    expect(summary.maxNumericSuffixByPrefix.kry).toBe(2);
  });
});

