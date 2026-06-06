import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

describe('build-lookup-v2-stretch-expansion-prompt', () => {
  it('emits a prompt that forbids qid and asks for JSONL only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stretch-prompt-'));
    try {
      const outputPath = path.join(dir, 'prompt.txt');
      execFileSync(
        'node',
        ['--import', 'tsx', 'scripts/eval/build-lookup-v2-stretch-expansion-prompt.ts', '--input', 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl', '--output', outputPath, '--rows', '20', '--resolved', '8', '--ambiguous', '4', '--redirect', '4', '--failed', '4'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      const prompt = readFileSync(outputPath, 'utf8');
      expect(prompt).toContain('do NOT include qid');
      expect(prompt).toContain('output JSONL only');
      expect(prompt).toContain('resolved=8');
      expect(prompt).toContain('ambiguous=4');
      expect(prompt).toContain('redirect_discovery=4');
      expect(prompt).toContain('failed=4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

