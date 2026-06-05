import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNormalizedQueryViews } from '../../../domain/query/service/query-normalizer.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../../domain/shared/constants/search-snapshot.js';
import { SearchSnapshotExactSafeRegistry } from '../search-snapshot-exact-safe-registry.js';

async function writeExactSafeArtifacts(): Promise<{ dir: string; manifestPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-exact-safe-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const artifactPath = path.join(dir, 'lookup-exact-safe-runtime.json');

  await fs.writeFile(
    artifactPath,
    JSON.stringify({
      schemaVersion: 'lookup_exact_safe_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-04T00:00:00.000Z',
      exactEntries: {
        페트러스: {
          entityId: 'wine-petrus-2016',
          locale: 'ko',
          certificate: {
            kind: 'exact_safe',
            normalizedSurface: '페트러스',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          },
        },
        로마네꽁띠: {
          entityId: 'w-drc-romanee-conti-2017',
          locale: 'ko',
          certificate: {
            kind: 'exact_safe',
            normalizedSurface: '로마네꽁띠',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          },
        },
      },
      compactEntries: {},
    }),
  );

  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      artifacts: {
        lookupExactSafeRuntimeJson: artifactPath,
      },
    }),
  );

  return { dir, manifestPath };
}

describe('SearchSnapshotExactSafeRegistry', () => {
  it('matches raw literal surfaces that strict normalization rewrites', async () => {
    const { manifestPath } = await writeExactSafeArtifacts();
    const registry = await SearchSnapshotExactSafeRegistry.loadFromManifest(manifestPath);

    const petrus = registry.match(buildNormalizedQueryViews('페트러스'));
    const romaneeConti = registry.match(buildNormalizedQueryViews('로마네꽁띠'));

    expect(petrus?.entityId).toBe('wine-petrus-2016');
    expect(romaneeConti?.entityId).toBe('w-drc-romanee-conti-2017');
  });

  it('fails closed when the manifest omits lookupExactSafeRuntimeJson', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-exact-safe-bad-'));
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        artifacts: {},
      }),
    );

    await expect(
      SearchSnapshotExactSafeRegistry.loadFromManifest(manifestPath),
    ).rejects.toThrow(/lookupExactSafeRuntimeJson|Required/);
  });
});
