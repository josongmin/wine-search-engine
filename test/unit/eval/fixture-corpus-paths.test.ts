import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OFFLINE_EVAL_GATE_CORPUS,
  requireFixtureCorpusPath,
  resolveFixtureCorpusPath,
} from '../../../scripts/eval/fixture-corpus-paths.ts';

const ORIGINAL_FIXTURE_REPO_PATH = process.env['FIXTURE_REPO_PATH'];

afterEach(async () => {
  if (ORIGINAL_FIXTURE_REPO_PATH === undefined) {
    delete process.env['FIXTURE_REPO_PATH'];
  } else {
    process.env['FIXTURE_REPO_PATH'] = ORIGINAL_FIXTURE_REPO_PATH;
  }
});

describe('fixture-corpus-paths', () => {
  it('resolves fixture corpus paths from the configured external repo', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'fixture-corpus-paths-'));
    const corpusPath = path.join(fixtureRoot, OFFLINE_EVAL_GATE_CORPUS);
    await mkdir(path.dirname(corpusPath), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'suites'), { recursive: true });
    await writeFile(corpusPath, '{"qid":"q-1"}\n', 'utf8');
    await writeFile(path.join(fixtureRoot, 'README.md'), '# fixture repo\n', 'utf8');

    process.env['FIXTURE_REPO_PATH'] = fixtureRoot;

    expect(resolveFixtureCorpusPath(OFFLINE_EVAL_GATE_CORPUS)).toBe(corpusPath);
    expect(
      requireFixtureCorpusPath(OFFLINE_EVAL_GATE_CORPUS, 'unit test fixture path resolution'),
    ).toBe(corpusPath);

    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('fails closed when the fixture repo is unavailable', () => {
    process.env['FIXTURE_REPO_PATH'] = path.join(os.tmpdir(), 'missing-fixture-repo');

    expect(resolveFixtureCorpusPath(OFFLINE_EVAL_GATE_CORPUS)).toBeNull();
    expect(() =>
      requireFixtureCorpusPath(OFFLINE_EVAL_GATE_CORPUS, 'unit test missing fixture repo'),
    ).toThrow(/external fixture corpus is required/);
  });
});
