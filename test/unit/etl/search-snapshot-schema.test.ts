import { describe, expect, it } from 'vitest';
import {
  buildSearchSnapshotId,
  hashStableJson,
  parseManifest,
  stableJsonStringify,
} from '../../../scripts/etl/search-snapshot-schema.js';

describe('search-snapshot-schema helpers', () => {
  it('stableJsonStringify is insensitive to object key order', () => {
    const left = {
      b: 2,
      a: {
        z: 1,
        y: [3, 2, 1],
      },
    };
    const right = {
      a: {
        y: [3, 2, 1],
        z: 1,
      },
      b: 2,
    };

    expect(stableJsonStringify(left)).toBe(stableJsonStringify(right));
    expect(hashStableJson(left)).toBe(hashStableJson(right));
  });

  it('builds deterministic snapshot ids from a content hash prefix', () => {
    expect(buildSearchSnapshotId('0123456789abcdef0123456789abcdef')).toBe(
      'search-snapshot:v1:0123456789abcdef',
    );
  });

  it('upgrades manifests with missing vespa feed fields while preserving required canonical fields', () => {
    const manifestPath = '/tmp/search-snapshots/search-snapshot:v1:legacy/manifest.json';
    const parsed = parseManifest(JSON.stringify({
      schemaVersion: 'search_snapshot.v1',
      snapshotId: 'search-snapshot:v1:legacy',
      generatedAt: '2026-04-16T00:00:00.000Z',
      contentHash: 'legacy-hash',
      sourceInputPath: '/tmp/silver.ndjson',
      artifacts: {
        documentsNdjson: '/tmp/search-snapshots/search-snapshot:v1:legacy/documents.ndjson',
        entitiesNdjson: '/tmp/search-snapshots/search-snapshot:v1:legacy/entities.ndjson',
        aliasesNdjson: '/tmp/search-snapshots/search-snapshot:v1:legacy/aliases.ndjson',
        ambiguityRegistryNdjson: '/tmp/search-snapshots/search-snapshot:v1:legacy/ambiguity.ndjson',
        nlMappingsJson: '/tmp/search-snapshots/search-snapshot:v1:legacy/nl-mappings.json',
        metadataJson: '/tmp/search-snapshots/search-snapshot:v1:legacy/metadata.json',
      },
      counts: {
        documents: 42,
        entities: 42,
        aliases: 10,
        ambiguityRegistry: 0,
        nlMappings: 3,
      },
      hashes: {
        documents: 'documents-hash',
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
        nlMappings: 'nl-hash',
      },
      fieldAvailability: {
        appellation: {
          populatedDocCount: 0,
          totalDocCount: 42,
          populatedDocRatio: 0,
        },
      },
      quality: {
        status: 'canonical',
        blockers: [],
        bypasses: [],
        carryForwardBenchmarkCount: 0,
        experimentalInputsPresent: false,
      },
    }), manifestPath);

    expect(parsed.artifacts.vespaFeedNdjson).toBe(
      '/tmp/search-snapshots/search-snapshot:v1:legacy/vespa-feed.ndjson',
    );
    expect(parsed.counts.vespaFeed).toBe(42);
    expect(parsed.hashes.vespaFeed).toBe('documents-hash');
  });
});
