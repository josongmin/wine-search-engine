import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('build-lookup-v2-stretch-expansion-prompt', () => {
  it('emits a prompt that forbids qid, asks for JSONL only, and creates parent dirs for output', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stretch-prompt-'));
    try {
      const inputPath = path.join(dir, 'stretch-corpus.jsonl');
      const outputPath = path.join(dir, 'nested', 'prompt.txt');
      writeFileSync(
        inputPath,
        [
          JSON.stringify({
            qid: 'elv2-krx-999',
            query: '테스트 와인',
            expected_status: 'resolved',
            expected_entity_hint: 'test wine',
            class: 'proof_resolved',
            note: 'proof resolved row',
          }),
          JSON.stringify({
            qid: 'elv2-krx-1000',
            query: '테스트 추천',
            expected_status: 'redirect_discovery',
            class: 'proof_redirect',
            note: 'proof redirect row',
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      execFileSync(
        'node',
        ['--import', 'tsx', 'scripts/eval/build-lookup-v2-stretch-expansion-prompt.ts', '--input', inputPath, '--output', outputPath, '--rows', '20', '--resolved', '8', '--ambiguous', '4', '--redirect', '4', '--failed', '4'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      const prompt = readFileSync(outputPath, 'utf8');
      expect(prompt).toContain('do NOT include qid');
      expect(prompt).toContain('output JSONL only');
      expect(prompt).toContain('ambiguous / failed rows MAY include expected_entity_hint');
      expect(prompt).toContain('redirect_discovery rows MUST NOT include expected_entity_hint or expected_entity_id');
      expect(prompt).toContain('resolved=8');
      expect(prompt).toContain('ambiguous=4');
      expect(prompt).toContain('redirect_discovery=4');
      expect(prompt).toContain('failed=4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
