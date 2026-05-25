/**
 * Regression: benchmark-anchor suitability artifact (`data/benchmarks/anchor-suitability-v1.json`)
 *
 * Why this is a regression test (append-only per CLAUDE.md test-discipline):
 *  - Before this fix, gift / beginner suitability scores for the benchmark
 *    anchor wines lived as a hardcoded TypeScript literal inside
 *    `scripts/etl/build-search-snapshot.ts`. That coupled catalog data with
 *    build code, blocked operator audit, and made model/prompt version
 *    drift invisible to `data/` git diff.
 *  - The artifact is now loaded + Zod-validated at runtime. These tests
 *    pin the contract so a future refactor (or an accidental schema relax)
 *    cannot silently regress.
 *
 * Covers:
 *  1. Artifact loads, validates, and contains every required benchmark anchor.
 *  2. Schema rejects out-of-range scores (`score > 1`).
 *  3. Schema rejects version mismatch.
 *  4. Schema rejects non-ISO8601 `generatedAt`.
 *  5. Snapshot of artifact meta + score shape is stable across builds.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH,
  loadBenchmarkAnchorSuitabilityArtifact,
  _resetBenchmarkAnchorSuitabilityArtifactCache,
} from '../../scripts/etl/build-search-snapshot.ts';

/**
 * Resolve the artifact under the repo (independent of `WINE_DATA_DIR`).
 * `resolveDataPath()` defaults to `~/.wine-search-engine/data/...` when that
 * directory exists, which is the production convention but not where the
 * git-tracked artifact lives during testing. The regression test pins the
 * repo copy explicitly.
 */
const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');
const REPO_ARTIFACT_PATH = path.join(
  REPO_ROOT,
  'data',
  'benchmarks',
  'anchor-suitability-v1.json',
);

/** Entity IDs that the snapshot build pipeline must continue to score. */
const REQUIRED_BENCHMARK_ANCHOR_ENTITY_IDS: readonly string[] = [
  'chateau-margaux-2015',
  'romanee-conti-2015',
  'moet-brut-nv',
  'yquem-2015',
  'sassicaia-2018',
  'masi-amarone-2015',
  'opus-one-2018',
];

async function writeTempArtifact(payload: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anchor-suitability-artifact-'));
  const filePath = path.join(dir, 'anchor-suitability-v1.json');
  await fs.writeFile(filePath, JSON.stringify(payload), 'utf8');
  return filePath;
}

describe('benchmark-anchor suitability artifact (regression)', () => {
  beforeEach(() => {
    _resetBenchmarkAnchorSuitabilityArtifactCache();
  });

  it('loads + validates default artifact and covers every required entity', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();

    expect(artifact.version).toBe('v1');
    expect(artifact.model).toBe('gpt-5.4-mini');
    expect(artifact.promptVersions.gift).toBe('gift-suitability-scorer-v2');
    expect(artifact.promptVersions.beginner).toBe('beginner-suitability-scorer-v2');
    expect(artifact.generatedAt).toBe('2026-04-17T00:00:00.000Z');

    for (const id of REQUIRED_BENCHMARK_ANCHOR_ENTITY_IDS) {
      const entry = artifact.entities[id];
      expect(entry, `missing benchmark anchor "${id}"`).toBeDefined();
      expect(entry!.gift.score).toBeGreaterThanOrEqual(0);
      expect(entry!.gift.score).toBeLessThanOrEqual(1);
      expect(entry!.beginner.score).toBeGreaterThanOrEqual(0);
      expect(entry!.beginner.score).toBeLessThanOrEqual(1);
      expect(entry!.gift.evidenceAxes.length).toBeGreaterThan(0);
      expect(entry!.beginner.evidenceAxes.length).toBeGreaterThan(0);
      expect(entry!.gift.snippet.length).toBeGreaterThan(0);
      expect(entry!.beginner.snippet.length).toBeGreaterThan(0);
      expect(entry!.gift.rationale.length).toBeGreaterThan(0);
      expect(entry!.beginner.rationale.length).toBeGreaterThan(0);
    }
  });

  it('memoizes by path: second read returns the same object reference', async () => {
    const first = await loadBenchmarkAnchorSuitabilityArtifact(REPO_ARTIFACT_PATH);
    const second = await loadBenchmarkAnchorSuitabilityArtifact(REPO_ARTIFACT_PATH);
    expect(second).toBe(first);
  });

  it('falls back to the in-repo artifact when the default path is missing', async () => {
    // No explicit path: relies on the loader's fallback path resolution.
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    expect(artifact.version).toBe('v1');
    expect(Object.keys(artifact.entities).length).toBeGreaterThanOrEqual(
      REQUIRED_BENCHMARK_ANCHOR_ENTITY_IDS.length,
    );
  });

  it('default artifact path resolves under the data directory', () => {
    expect(DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH).toMatch(
      /data\/benchmarks\/anchor-suitability-v1\.json$/,
    );
  });

  it('rejects malformed artifact: score > 1', async () => {
    const malformed = {
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {
        'chateau-margaux-2015': {
          gift: {
            score: 1.5,
            evidenceAxes: ['occasion'],
            snippet: 'x',
            rationale: 'x',
          },
          beginner: {
            score: 0.5,
            evidenceAxes: ['body'],
            snippet: 'x',
            rationale: 'x',
          },
        },
      },
    };
    const filePath = await writeTempArtifact(malformed);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects malformed artifact: score < 0', async () => {
    const malformed = {
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {
        'chateau-margaux-2015': {
          gift: {
            score: -0.1,
            evidenceAxes: ['occasion'],
            snippet: 'x',
            rationale: 'x',
          },
          beginner: {
            score: 0.5,
            evidenceAxes: ['body'],
            snippet: 'x',
            rationale: 'x',
          },
        },
      },
    };
    const filePath = await writeTempArtifact(malformed);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects version mismatch (v2)', async () => {
    const wrongVersion = {
      version: 'v2',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {},
    };
    const filePath = await writeTempArtifact(wrongVersion);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects non-ISO8601 generatedAt', async () => {
    const badDate = {
      version: 'v1',
      generatedAt: '2026/04/17',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {},
    };
    const filePath = await writeTempArtifact(badDate);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects unknown top-level key (strict schema)', async () => {
    const stowaway = {
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {},
      hiddenField: 'should fail',
    };
    const filePath = await writeTempArtifact(stowaway);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects empty model / promptVersion strings (min(1))', async () => {
    const emptyModel = {
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: '',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entities: {},
    };
    const filePath = await writeTempArtifact(emptyModel);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('byte-equivalent snapshot of default artifact meta (drift guard)', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    expect({
      version: artifact.version,
      generatedAt: artifact.generatedAt,
      model: artifact.model,
      promptVersions: artifact.promptVersions,
      entityIds: Object.keys(artifact.entities).sort(),
    }).toEqual({
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      model: 'gpt-5.4-mini',
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      entityIds: [...REQUIRED_BENCHMARK_ANCHOR_ENTITY_IDS].sort(),
    });
  });

  it('preserves byte-equivalent gift/beginner scores from pre-extraction literal', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    // Numbers below were the values inlined in scripts/etl/build-search-snapshot.ts
    // before the data/code split. If any of them drifts, the snapshot build
    // changes for benchmark anchors — that needs an explicit version bump.
    const expectedScores: Record<string, { gift: number; beginner: number }> = {
      'chateau-margaux-2015': { gift: 0.96, beginner: 0.18 },
      'romanee-conti-2015':  { gift: 0.98, beginner: 0.28 },
      'moet-brut-nv':        { gift: 0.88, beginner: 0.62 },
      'yquem-2015':          { gift: 0.96, beginner: 0.72 },
      'sassicaia-2018':      { gift: 0.94, beginner: 0.22 },
      'masi-amarone-2015':   { gift: 0.88, beginner: 0.18 },
      'opus-one-2018':       { gift: 0.92, beginner: 0.28 },
    };
    for (const [id, expected] of Object.entries(expectedScores)) {
      const entry = artifact.entities[id];
      expect(entry, `missing benchmark anchor "${id}"`).toBeDefined();
      expect(entry!.gift.score).toBe(expected.gift);
      expect(entry!.beginner.score).toBe(expected.beginner);
    }
  });
});
