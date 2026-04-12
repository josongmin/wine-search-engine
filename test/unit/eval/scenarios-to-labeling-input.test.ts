import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_TOP_K_CANDIDATES,
  runBridge,
} from '../../../scripts/eval/scenarios-to-labeling-input.ts';

const ORIGINAL_FIXTURE_REPO_PATH = process.env['FIXTURE_REPO_PATH'];

afterEach(async () => {
  if (ORIGINAL_FIXTURE_REPO_PATH === undefined) {
    delete process.env['FIXTURE_REPO_PATH'];
  } else {
    process.env['FIXTURE_REPO_PATH'] = ORIGINAL_FIXTURE_REPO_PATH;
  }
});

describe('scenarios-to-labeling-input', () => {
  it('defaults to fixture-native corpus export instead of AGENT_SCENARIOS synthesis', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'fixture-labeling-input-'));
    const corpusPath = path.join(
      fixtureRoot,
      'corpora/relevance/scenarios-labeling-input.jsonl',
    );
    const outputPath = path.join(fixtureRoot, 'out/labeling-input.snapshot.jsonl');
    const expectedPayload = [
      JSON.stringify({
        queryId: 'scenario-1',
        query: 'Opus One 2018',
        candidates: [{ entityId: 'wine-1', canonicalLabel: 'Opus One' }],
      }),
      '',
    ].join('\n');

    await mkdir(path.dirname(corpusPath), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'suites'), { recursive: true });
    await writeFile(corpusPath, expectedPayload, 'utf8');
    await writeFile(path.join(fixtureRoot, 'README.md'), '# fixture repo\n', 'utf8');

    process.env['FIXTURE_REPO_PATH'] = fixtureRoot;

    const result = await runBridge({
      output: outputPath,
      limit: 1,
      topK: DEFAULT_TOP_K_CANDIDATES,
      ontology: 'data/entity-ontology.json',
      sourceMode: 'fixture_corpus',
      help: false,
    });

    expect(result.linesWritten).toBe(1);
    expect(await readFile(outputPath, 'utf8')).toBe(expectedPayload);

    await rm(fixtureRoot, { recursive: true, force: true });
  });
});
