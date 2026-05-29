import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildEmbeddingSensitiveHumanGoldCorpus,
} from '../../../scripts/eval/build-embedding-sensitive-human-gold-corpus.js';
import { assertEmbeddingSensitiveGovernance } from '../../../scripts/eval/embedding-sensitive-offline-eval.js';

const TEMP_PATH = path.join('/tmp', `embedding-sensitive-human-gold-test-${process.pid}.jsonl`);

afterEach(async () => {
  await fs.rm(TEMP_PATH, { force: true });
});

describe('embedding-sensitive human-gold corpus builder', () => {
  it('builds a governance-complete corpus from the curated human-gold substrate', async () => {
    const queries = await buildEmbeddingSensitiveHumanGoldCorpus();

    const summary = assertEmbeddingSensitiveGovernance(queries);
    expect(summary.queryCount).toBeGreaterThanOrEqual(20);
    expect(summary.queryClassMix['semantic_preference']).toBeGreaterThanOrEqual(8);
    expect(summary.queryClassMix['exploration']).toBeGreaterThanOrEqual(4);
    expect(summary.queryClassMix['similar_compare']).toBeGreaterThanOrEqual(4);
    expect(new Set(queries.map((query) => query.qid)).size).toBe(queries.length);
    expect(queries.every((query) => query.annotation_tier === 'gate')).toBe(true);
    expect(queries.every((query) =>
      query.retrieval_labels.relevant.filter((judgment) => judgment.grade >= 2).length >= 3,
    )).toBe(true);
  });

  it('fails closed when a curated scenario loses listwise human-gold coverage', async () => {
    await fs.writeFile(
      TEMP_PATH,
      [
        JSON.stringify({
          queryId: 'scenario-2',
          query: '풀바디 레드 와인 추천',
          entityId: 'w-a',
          canonicalLabel: 'Wine A',
          grade: 3,
          confidence: 1,
          source: 'human_gold',
          labelerModel: 'human',
          rationale: 'top match',
          auditedBy: 'tester',
          auditedAt: 1,
        }),
        JSON.stringify({
          queryId: 'scenario-2',
          query: '풀바디 레드 와인 추천',
          entityId: 'w-b',
          canonicalLabel: 'Wine B',
          grade: 2,
          confidence: 1,
          source: 'human_gold',
          labelerModel: 'human',
          rationale: 'second match',
          auditedBy: 'tester',
          auditedAt: 1,
        }),
        JSON.stringify({
          queryId: 'scenario-2',
          query: '풀바디 레드 와인 추천',
          entityId: 'w-c',
          canonicalLabel: 'Wine C',
          grade: 1,
          confidence: 1,
          source: 'human_gold',
          labelerModel: 'human',
          rationale: 'weak match',
          auditedBy: 'tester',
          auditedAt: 1,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await expect(buildEmbeddingSensitiveHumanGoldCorpus({
      judgmentsPath: TEMP_PATH,
    })).rejects.toThrow(/scenario-2 has only 2 relevant judgments/);
  });
});
