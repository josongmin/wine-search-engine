import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';
const {
  mockVerifySearchSnapshotRuntimeStateLive,
  mockLoadSearchSnapshotRuntimeState,
} = vi.hoisted(() => ({
  mockVerifySearchSnapshotRuntimeStateLive: vi.fn(),
  mockLoadSearchSnapshotRuntimeState: vi.fn(),
}));

vi.mock('../../../src/infrastructure/health/search-snapshot-readiness.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/infrastructure/health/search-snapshot-readiness.js')>(
    '../../../src/infrastructure/health/search-snapshot-readiness.js',
  );
  return {
    ...actual,
    loadSearchSnapshotRuntimeState: mockLoadSearchSnapshotRuntimeState,
    verifySearchSnapshotRuntimeStateLive: mockVerifySearchSnapshotRuntimeStateLive,
  };
});

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
  beforeEach(() => {
    mockVerifySearchSnapshotRuntimeStateLive.mockReset();
    mockVerifySearchSnapshotRuntimeStateLive.mockResolvedValue(undefined);
    mockLoadSearchSnapshotRuntimeState.mockReset();
  });

  it('returns up for a coherent runtime state with zero ambiguity rows', async () => {
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
        ambiguityRegistry: 0,
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
        ambiguityRegistry: 0,
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

  it('returns up when zero active LTR models are present and missing LTR is explicitly allowed', async () => {
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
      allowMissingLtr: true,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 0,
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

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('up');
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
        ambiguityRegistry: 0,
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

  it('registers search snapshot runtime readiness as required in all environments (T-E7-02 strict fail-closed)', () => {
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
    expect(testHealth.readiness?.search_snapshot_runtime?.required).toBe(true);
  });

  it('uses strict hash verification when the runtime readiness probe runs with a pool', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {
      pool: { query: async () => ({ rows: [] }) } as never,
    });

    await expect(health.readiness?.search_snapshot_runtime?.check?.()).resolves.toBe('up');
    expect(mockVerifySearchSnapshotRuntimeStateLive).toHaveBeenCalledTimes(1);
    expect(mockVerifySearchSnapshotRuntimeStateLive).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: expect.anything(),
        vespaUrl: config.vespa.url,
        strictHashes: true,
      }),
    );
  });

  it('surfaces the no-active-LTR runtime state explicitly when no pool is available', async () => {
    mockLoadSearchSnapshotRuntimeState.mockResolvedValue({
      allowMissingLtr: false,
      counts: {
        activeLtrModels: 0,
      },
    });

    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    await expect(health.readiness?.search_snapshot_runtime?.check?.()).rejects.toThrow(
      /Active LTR runtime count is zero without explicit no-LTR mode/,
    );
  });

  it('surfaces an unloaded drinking-window predictor as a degraded readiness check', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, undefined, {
      modelVersion: 'unloaded',
      predict: () => ({
        drinkingWindowStart: 2020,
        drinkingWindowEnd: 2030,
        peakYear: 2025,
        confidence: 'medium',
        modelVersion: 'unloaded',
      }),
    });

    expect(health.readiness?.drinking_window_model).toBeDefined();
    await expect(health.readiness?.drinking_window_model?.check?.()).rejects.toThrow(
      /drinking window predictor unloaded/,
    );
  });

  it('accepts deterministic drinking-window predictors as a healthy readiness check', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, undefined, {
      modelVersion: 'deterministic:structural-slot-v2',
      predict: () => ({
        drinkingWindowStart: 2020,
        drinkingWindowEnd: 2030,
        peakYear: 2025,
        confidence: 'medium',
        modelVersion: 'deterministic:structural-slot-v2',
      }),
    });

    await expect(health.readiness?.drinking_window_model?.check?.()).resolves.toBe('up');
  });

  it('surfaces a missing runtime LTR artifact as a required readiness check', async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, 'runtime-ltr-models.json');
    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: missingPath,
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.runtime_ltr_artifact).toBeDefined();
    expect(health.readiness?.runtime_ltr_artifact?.required).toBe(true);
    await expect(health.readiness?.runtime_ltr_artifact?.check?.()).rejects.toThrow(
      /runtime LTR artifact unavailable/,
    );
  });

  it('downgrades runtime LTR artifact to advisory when the remote reranker is configured', async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, 'runtime-ltr-models.json');
    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: missingPath,
      COHERE_API_KEY: 'co-test-key',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.runtime_ltr_artifact).toBeDefined();
    expect(health.readiness?.runtime_ltr_artifact?.required).toBe(false);
    expect(health.readiness?.reranker).toBeDefined();
  });

  it('probes benchmark persistence with a read-only schema and privilege check when eval startup is enabled', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      EVAL_RUN_AT_STARTUP: 'true',
    });

    const query = vi.fn(async (text: string) => {
        if (text.includes('to_regclass')) {
          return {
            rows: [{
              runs_table: 'eval_benchmark_runs',
              metrics_view: 'eval_benchmark_run_metrics_v',
              trends_view: 'eval_benchmark_run_trends_v',
              can_insert: true,
            }],
          };
        }
        return {
          rows: [
            { column_name: 'run_id' },
            { column_name: 'benchmark_kind' },
            { column_name: 'search_snapshot_id' },
            { column_name: 'eval_dataset_version' },
            { column_name: 'feature_schema_hash' },
            { column_name: 'query_count' },
            { column_name: 'recall_at_1' },
            { column_name: 'recall_at_3' },
            { column_name: 'mrr' },
            { column_name: 'false_exact_rate' },
            { column_name: 'release_gate_passed' },
            { column_name: 'activation_status' },
            { column_name: 'report_json' },
            { column_name: 'metrics' },
            { column_name: 'created_at' },
          ],
        };
      });
    const client = {
      query,
      release: () => {},
    };
    const health = buildHealthRouteOptions(config, {
      pool: {
        connect: async () => client,
      } as never,
    });

    expect(health.readiness?.benchmark_persistence).toBeDefined();
    expect(health.readiness?.benchmark_persistence?.required).toBe(true);
    await expect(health.readiness?.benchmark_persistence?.check?.()).resolves.toBe('up');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([text]) => String(text).includes('INSERT INTO eval_benchmark_runs'))).toBe(false);
    expect(query.mock.calls.some(([text]) => String(text).includes('BEGIN'))).toBe(false);
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
