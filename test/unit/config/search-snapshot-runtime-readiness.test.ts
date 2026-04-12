import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';
import {
  canonicalizeAliasRuntimeRows,
  canonicalizeAmbiguityRuntimeRows,
  canonicalizeEntityRuntimeRows,
  probeSearchSnapshotRuntimeState,
} from '../../../src/infrastructure/health/search-snapshot-readiness.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../../src/shared/utils/stable-json.js';

function hashRuntimeNlMappings(payload: unknown): string {
  return hashText(`${stableJsonStringify(payload)}\n`);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-readiness-'));
}

describe('search snapshot runtime readiness', () => {
  it('returns up for a coherent runtime state with populated NL mappings', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const nlMappingsPayload = { mappings: [{ key: 'full-bodied', canonical: 'full' }] };

    await fs.writeFile(nlMappingsPath, JSON.stringify(nlMappingsPayload));
    await fs.writeFile(runtimeStatePath, JSON.stringify({
      schemaVersion: 'search_snapshot_runtime_state.v3',
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'abc123',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/manifest.json',
      nlMappingsRuntimePath: nlMappingsPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
        nlMappings: hashRuntimeNlMappings(nlMappingsPayload),
        activeLtrModels: 'ltr-hash',
      },
    }));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('up');
  });

  it('returns down when zero active LTR models are present without explicit no-LTR mode', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const nlMappingsPayload = { mappings: [{ key: 'full-bodied', canonical: 'full' }] };

    await fs.writeFile(nlMappingsPath, JSON.stringify(nlMappingsPayload));
    await fs.writeFile(runtimeStatePath, JSON.stringify({
      schemaVersion: 'search_snapshot_runtime_state.v3',
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'abc123',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/manifest.json',
      nlMappingsRuntimePath: nlMappingsPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 0,
      },
      hashes: {
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
        nlMappings: hashRuntimeNlMappings(nlMappingsPayload),
        activeLtrModels: 'ltr-hash',
      },
    }));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('down');
  });

  it('returns down when NL mappings hash does not match runtime state', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');

    await fs.writeFile(nlMappingsPath, JSON.stringify({
      mappings: [{ key: 'full-bodied', canonical: 'full' }],
    }));
    await fs.writeFile(runtimeStatePath, JSON.stringify({
      schemaVersion: 'search_snapshot_runtime_state.v3',
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'abc123',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/manifest.json',
      nlMappingsRuntimePath: nlMappingsPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
        nlMappings: 'mismatched-hash',
        activeLtrModels: 'ltr-hash',
      },
    }));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('down');
  });

  it('registers search snapshot runtime readiness and requires it only in production', () => {
    const prodConfig = parseEnv({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'prod-secret-1234',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    const testConfig = parseEnv({
      NODE_ENV: 'test',
    });

    const prodHealth = buildHealthRouteOptions(prodConfig, {});
    const testHealth = buildHealthRouteOptions(testConfig, {});

    expect(prodHealth.readiness?.search_snapshot_runtime).toBeDefined();
    expect(prodHealth.readiness?.search_snapshot_runtime?.required).toBe(true);
    expect(testHealth.readiness?.search_snapshot_runtime).toBeDefined();
    expect(testHealth.readiness?.search_snapshot_runtime?.required).toBe(false);
  });

  it('canonicalizes runtime entity/alias/ambiguity rows into snapshot hash space', () => {
    const entityHash = hashStableJson([
      {
        entityId: 'wine-1',
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        identitySignature: 'opus-one-2018',
        relations: { producer: 'opus-one' },
        attributes: { vintage: 2018 },
        metadata: { country: 'US' },
      },
    ]);
    const aliasHash = hashStableJson([
      {
        aliasId: 'alias-1',
        entityId: 'wine-1',
        value: '오퍼스 원 2018',
        normalizedValue: '오퍼스원2018',
        type: 'korean_alias',
        scope: 'entity',
        source: 'fixture',
        sourceTrust: 1.0,
        confidencePrior: 0.95,
      },
    ]);
    const ambiguityHash = hashStableJson([
      {
        registryId: 'amb-1',
        normalizedForm: 'opusone',
        entityIds: ['wine-1', 'wine-2'],
        ambiguityTypes: ['short_form'],
        severity: 'medium',
      },
    ]);

    expect(hashStableJson(canonicalizeEntityRuntimeRows([
      {
        entity_id: 'wine-1',
        entity_type: 'wine',
        canonical_label: 'Opus One 2018',
        identity_signature: 'opus-one-2018',
        relations: { producer: 'opus-one' },
        attributes: { vintage: 2018 },
        metadata: { country: 'US' },
      },
    ]))).toBe(entityHash);
    expect(hashStableJson(canonicalizeAliasRuntimeRows([
      {
        alias_id: 'alias-1',
        entity_id: 'wine-1',
        alias_type: 'korean_alias',
        alias_scope: 'entity',
        surface_form: '오퍼스 원 2018',
        normalized_value: '오퍼스원2018',
        source: 'fixture',
        source_trust: 1.0,
        confidence: 0.95,
      },
    ]))).toBe(aliasHash);
    expect(hashStableJson(canonicalizeAmbiguityRuntimeRows([
      {
        registry_id: 'amb-1',
        normalized_form: 'opusone',
        entity_ids: ['wine-1', 'wine-2'],
        ambiguity_types: ['short_form'],
        severity: 'medium',
      },
    ]))).toBe(ambiguityHash);
  });
});
