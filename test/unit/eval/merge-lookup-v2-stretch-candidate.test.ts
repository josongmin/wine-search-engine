import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('merge-lookup-v2-stretch-candidate', () => {
  it('assigns qids to qid-less candidate rows and appends them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stretch-merge-'));
    try {
      const corpusPath = path.join(dir, 'corpus.jsonl');
      const candidatePath = path.join(dir, 'candidate.jsonl');
      const outputPath = path.join(dir, 'merged.jsonl');
      writeFileSync(
        corpusPath,
        [
          JSON.stringify({
            qid: 'elv2-kry-001',
            query: '기존 쿼리',
            expected_status: 'resolved',
            expected_entity_hint: 'foo',
            class: 'realworld_exact_vintage',
            note: 'existing',
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      writeFileSync(
        candidatePath,
        [
          JSON.stringify({
            query: '새 쿼리',
            expected_status: 'failed',
            class: 'realworld_adversarial_no_match',
            note: 'candidate',
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      execFileSync(
        'node',
        ['--import', 'tsx', 'scripts/eval/merge-lookup-v2-stretch-candidate.ts', '--corpus', corpusPath, '--candidate', candidatePath, '--output', outputPath, '--qidPrefix', 'kry'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );

      const merged = readFileSync(outputPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { qid: string; query: string });
      expect(merged).toHaveLength(2);
      expect(merged[1]).toEqual(expect.objectContaining({
        qid: 'elv2-kry-002',
        query: '새 쿼리',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
