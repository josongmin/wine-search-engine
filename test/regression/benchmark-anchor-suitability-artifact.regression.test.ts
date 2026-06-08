import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS,
  DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH,
  REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH,
  _resetBenchmarkAnchorSuitabilityArtifactCache,
  assertAuthoritativeBenchmarkAnchorSuitabilityArtifact,
  loadBenchmarkAnchorSuitabilityArtifact,
  resolveBenchmarkAnchorSuitabilitySourceDataset,
} from '../../scripts/etl/build-search-snapshot.ts';
import { hashStableJson } from '../../src/domain/shared/utils/stable-json.ts';

function makeValidEntry(sourceDataset: 'seed_wines_real' | 'repo_gold_wine_catalog' = 'seed_wines_real') {
  return {
    sourceDataset,
    gift: {
      score: 0.72,
      evidenceAxes: ['occasion'],
      snippet: 'gift evidence',
      rationale: 'gift rationale',
      generationSource: 'llm_teacher_generated' as const,
    },
    beginner: {
      score: 0.36,
      evidenceAxes: ['body'],
      snippet: 'beginner evidence',
      rationale: 'beginner rationale',
      generationSource: 'llm_teacher_generated' as const,
    },
  };
}

function makeMinimalArtifact() {
  return {
    version: 'v1' as const,
    generatedAt: '2026-04-17T00:00:00.000Z',
    models: {
      gift: 'gpt-5.4-mini',
      beginner: 'gpt-5.4-mini',
    },
    promptVersions: {
      gift: 'gift-suitability-scorer-v2',
      beginner: 'beginner-suitability-scorer-v2',
    },
    requiredEntityIds: ['chateau-margaux-2015'],
    entities: {
      'chateau-margaux-2015': makeValidEntry(),
    },
  };
}

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

  it('loads + validates the default artifact and closes the authoritative gate', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();

    expect(artifact.version).toBe('v1');
    expect(artifact.models.gift.length).toBeGreaterThan(0);
    expect(artifact.models.beginner.length).toBeGreaterThan(0);
    expect(artifact.promptVersions).toEqual({
      gift: 'gift-suitability-scorer-v2',
      beginner: 'beginner-suitability-scorer-v2',
    });
    expect(artifact.requiredEntityIds).toEqual(AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS);

    assertAuthoritativeBenchmarkAnchorSuitabilityArtifact(artifact);

    for (const entityId of AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS) {
      const entry = artifact.entities[entityId];
      expect(entry, `missing benchmark anchor "${entityId}"`).toBeDefined();
      expect(entry!.sourceDataset).toBe(resolveBenchmarkAnchorSuitabilitySourceDataset(entityId));
      expect(entry!.gift.score).toBeGreaterThanOrEqual(0);
      expect(entry!.gift.score).toBeLessThanOrEqual(1);
      expect(entry!.beginner.score).toBeGreaterThanOrEqual(0);
      expect(entry!.beginner.score).toBeLessThanOrEqual(1);
      expect(entry!.gift.generationSource).toBe('llm_teacher_generated');
      expect(entry!.beginner.generationSource).toBe('llm_teacher_generated');
      expect(entry!.gift.snippet.length).toBeGreaterThan(0);
      expect(entry!.beginner.snippet.length).toBeGreaterThan(0);
      expect(entry!.gift.rationale.length).toBeGreaterThan(0);
      expect(entry!.beginner.rationale.length).toBeGreaterThan(0);
    }
  });

  it('memoizes by path: second read returns the same object reference', async () => {
    const first = await loadBenchmarkAnchorSuitabilityArtifact(REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH);
    const second = await loadBenchmarkAnchorSuitabilityArtifact(REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH);
    expect(second).toBe(first);
  });

  it('falls back to the in-repo artifact when the default path is missing', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    expect(artifact.version).toBe('v1');
    expect(Object.keys(artifact.entities).length).toBe(AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS.length);
  });

  it('default artifact path resolves under the data directory', () => {
    expect(DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH).toMatch(
      /data\/benchmarks\/anchor-suitability-v1\.json$/,
    );
  });

  it('rejects malformed artifact: score > 1', async () => {
    const malformed = makeMinimalArtifact();
    malformed.entities['chateau-margaux-2015']!.gift.score = 1.5;

    const filePath = await writeTempArtifact(malformed);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects malformed artifact: score < 0', async () => {
    const malformed = makeMinimalArtifact();
    malformed.entities['chateau-margaux-2015']!.gift.score = -0.1;

    const filePath = await writeTempArtifact(malformed);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects version mismatch (v2)', async () => {
    const wrongVersion = {
      ...makeMinimalArtifact(),
      version: 'v2',
    };

    const filePath = await writeTempArtifact(wrongVersion);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects non-ISO8601 generatedAt', async () => {
    const badDate = {
      ...makeMinimalArtifact(),
      generatedAt: '2026/04/17',
    };

    const filePath = await writeTempArtifact(badDate);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects unknown top-level key (strict schema)', async () => {
    const stowaway = {
      ...makeMinimalArtifact(),
      hiddenField: 'should fail',
    };

    const filePath = await writeTempArtifact(stowaway);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects empty model / promptVersion strings (min(1))', async () => {
    const emptyModel = makeMinimalArtifact();
    emptyModel.models.gift = '';

    const filePath = await writeTempArtifact(emptyModel);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects missing generationSource on a score row', async () => {
    const malformed = makeMinimalArtifact() as Record<string, unknown>;
    const entities = malformed['entities'] as Record<string, unknown>;
    const margaux = entities['chateau-margaux-2015'] as Record<string, unknown>;
    const gift = margaux['gift'] as Record<string, unknown>;
    delete gift['generationSource'];

    const filePath = await writeTempArtifact(malformed);
    await expect(loadBenchmarkAnchorSuitabilityArtifact(filePath)).rejects.toThrow(
      /failed schema validation/,
    );
  });

  it('rejects requiredEntityIds drift under the authoritative gate', () => {
    const malformed = {
      ...makeMinimalArtifact(),
      requiredEntityIds: ['chateau-margaux-2015'],
      entities: {
        'chateau-margaux-2015': makeValidEntry(),
      },
    };

    expect(() => assertAuthoritativeBenchmarkAnchorSuitabilityArtifact(malformed as never)).toThrow(
      /requiredEntityIds drifted/,
    );
  });

  it('rejects sourceDataset drift under the authoritative gate', () => {
    const malformed = {
      ...makeMinimalArtifact(),
      requiredEntityIds: AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS,
      entities: Object.fromEntries(
        AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS.map((entityId) => [
          entityId,
          makeValidEntry('seed_wines_real'),
        ]),
      ),
    };

    expect(() => assertAuthoritativeBenchmarkAnchorSuitabilityArtifact(malformed as never)).toThrow(
      /sourceDataset mismatch/,
    );
  });

  it('pins a stable authoritative artifact hash excluding generatedAt', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    expect(hashStableJson({
      version: artifact.version,
      models: artifact.models,
      promptVersions: artifact.promptVersions,
      requiredEntityIds: artifact.requiredEntityIds,
      entities: artifact.entities,
    })).toBe('73164ac82b6a90a3c87e1eff5910e73ec93f84681915d75ee559ade539ffeb92');
  });
});
