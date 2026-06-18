import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchSnapshotConceptRedirectRegistry } from '../search-snapshot-concept-redirect-registry.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../../domain/shared/constants/search-snapshot.js';

async function writeConceptArtifacts(): Promise<{ dir: string; manifestPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-concept-redirect-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const artifactPath = path.join(dir, 'lookup-concept-redirect-runtime.json');

  await fs.writeFile(
    artifactPath,
    JSON.stringify({
      schemaVersion: 'lookup_concept_redirect_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-04T00:00:00.000Z',
      entries: {
        '샴페인 추천': {
          normalizedForm: '샴페인 추천',
          locale: 'ko',
          conceptClass: 'recommendation',
          redirectReason: 'concept_query',
          sourceEvidence: 'test',
        },
      },
    }),
  );

  await fs.writeFile(
    manifestPath,
      JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        artifacts: { lookupConceptRedirectRuntimeJson: artifactPath },
      }),
  );

  return { dir, manifestPath };
}

describe('SearchSnapshotConceptRedirectRegistry', () => {
  it('loads concept redirect entries from a manifest-backed runtime artifact', async () => {
    const { manifestPath } = await writeConceptArtifacts();

    const registry = await SearchSnapshotConceptRedirectRegistry.loadFromManifest(manifestPath);

    expect(registry.get('샴페인 추천')).toEqual(expect.objectContaining({
      conceptClass: 'recommendation',
      redirectReason: 'concept_query',
      sourceEvidence: 'test',
    }));
  });

  it('fails closed when the manifest omits lookupConceptRedirectRuntimeJson', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-concept-redirect-bad-'));
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        artifacts: {},
      }),
    );

    await expect(
      SearchSnapshotConceptRedirectRegistry.loadFromManifest(manifestPath),
    ).rejects.toThrow(/lookupConceptRedirectRuntimeJson|Required/);
  });
});
