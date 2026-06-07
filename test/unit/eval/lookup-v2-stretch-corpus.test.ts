import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignLookupV2StretchQids,
  loadLookupV2StretchCorpusSync,
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

  it('allows entity-intended ambiguous and failed rows to retain expected entity hints', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stretch-corpus-'));
    const inputPath = path.join(dir, 'stretch.jsonl');
    try {
      writeFileSync(
        inputPath,
        [
          JSON.stringify({
            qid: 'elv2-krx-001',
            query: '마세토 2018',
            expected_status: 'ambiguous',
            expected_entity_hint: 'masseto',
            class: 'realworld_exact_vintage',
            note: 'clarification needed',
          }),
          JSON.stringify({
            qid: 'elv2-krx-002',
            query: '살롱 2012',
            expected_status: 'failed',
            expected_entity_hint: 'salon',
            class: 'realworld_exact_vintage',
            note: 'catalog support absent',
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      expect(loadLookupV2StretchCorpusSync(inputPath)).toEqual([
        expect.objectContaining({
          qid: 'elv2-krx-001',
          expected_status: 'ambiguous',
          expected_entity_hint: 'masseto',
        }),
        expect.objectContaining({
          qid: 'elv2-krx-002',
          expected_status: 'failed',
          expected_entity_hint: 'salon',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when redirect_discovery rows leak entity hints', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stretch-corpus-'));
    const inputPath = path.join(dir, 'stretch.jsonl');
    try {
      writeFileSync(
        inputPath,
        `${JSON.stringify({
          qid: 'elv2-krx-003',
          query: '나파 까쇼 추천',
          expected_status: 'redirect_discovery',
          expected_entity_hint: 'opus one',
          class: 'realworld_grape_recommendation',
          note: 'invalid redirect leak',
        })}\n`,
        'utf8',
      );

      expect(() => loadLookupV2StretchCorpusSync(inputPath)).toThrow(/redirect_discovery row must not carry expected_entity_hint/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
