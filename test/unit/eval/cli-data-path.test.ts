import path from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lookupV2DraftCliPath, resolveCliDataPathArg } from '../../../scripts/eval/cli-data-path.js';

describe('resolveCliDataPathArg', () => {
  it('routes repo-relative data paths into the shared home data dir', () => {
    expect(resolveCliDataPathArg('data/eval-results.json')).toBe(
      path.resolve(homedir(), '.wine-search-engine', 'data', 'eval-results.json'),
    );
  });

  it('leaves absolute paths untouched', () => {
    expect(resolveCliDataPathArg('/tmp/offline-eval.json')).toBe('/tmp/offline-eval.json');
  });

  it('leaves non-data relative paths untouched', () => {
    expect(resolveCliDataPathArg('reports/eval-results.json')).toBe('reports/eval-results.json');
  });

  it('builds lookup-v2 draft defaults through a single helper', () => {
    expect(lookupV2DraftCliPath()).toBe('data/lookup-v2/drafts');
    expect(lookupV2DraftCliPath('manual-target-owner-evidence/index.json')).toBe(
      'data/lookup-v2/drafts/manual-target-owner-evidence/index.json',
    );
  });
});
