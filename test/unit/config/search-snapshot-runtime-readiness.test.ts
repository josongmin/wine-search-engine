import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../../src/domain/shared/constants/search-snapshot.js';
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
import { hashStableJson, hashText, stableJsonStringify } from '../../../src/domain/shared/utils/stable-json.js';

function hashRuntimeNlMappings(payload: unknown): string {
  return hashText(`${stableJsonStringify(payload)}\n`);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'search-snapshot-readiness-'));
}

const CANONICAL_QUALITY = {
  status: 'canonical',
  blockers: [],
  bypasses: [],
  carryForwardBenchmarkCount: 0,
  experimentalInputsPresent: false,
} as const;

const FIELD_AVAILABILITY = {
  appellation: {
    populatedDocCount: 8,
    totalDocCount: 10,
    populatedDocRatio: 0.8,
  },
  body: {
    populatedDocCount: 6,
    totalDocCount: 10,
    populatedDocRatio: 0.6,
  },
  sweetness: {
    populatedDocCount: 6,
    totalDocCount: 10,
    populatedDocRatio: 0.6,
  },
  acidity: {
    populatedDocCount: 6,
    totalDocCount: 10,
    populatedDocRatio: 0.6,
  },
  tannin: {
    populatedDocCount: 6,
    totalDocCount: 10,
    populatedDocRatio: 0.6,
  },
} as const;

function makeRuntimeStatePayload(args: {
  readonly dir: string;
  readonly nlMappingsPath: string;
  readonly nlMappingsPayloadHash: string;
  readonly activeLtrModels: number;
  readonly fieldAvailability?: unknown;
}) {
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: 'search-snapshot:v1:test',
    contentHash: 'abc123',
    publishedAt: '2026-04-12T00:00:00.000Z',
    manifestPath: '/tmp/manifest.json',
    nlMappingsRuntimePath: args.nlMappingsPath,
    lookupAliasRuntimePath: path.join(args.dir, 'lookup-alias-runtime.json'),
    lookupExactSafeRuntimePath: path.join(args.dir, 'lookup-exact-safe-runtime.json'),
    lookupResolverProjectionPath: path.join(args.dir, 'lookup-resolver-projection.json'),
    lookupEntityProjectionPath: path.join(args.dir, 'lookup-entity-projection.json'),
    lookupAmbiguityRuntimePath: path.join(args.dir, 'lookup-ambiguity-runtime.json'),
    lookupConceptRedirectRuntimePath: path.join(args.dir, 'lookup-concept-redirect-runtime.json'),
    counts: {
      entities: 10,
      aliases: 10,
      lookupAliasRuntimeAliases: 10,
      lookupExactSafeRuntimeEntries: 0,
      lookupResolverProjectionDocuments: 10,
      lookupEntityProjectionDocuments: 10,
      lookupAmbiguityRuntimeEntries: 0,
      lookupConceptRedirectRuntimeEntries: 0,
      ambiguityRegistry: 0,
      nlMappings: 1,
      activeLtrModels: args.activeLtrModels,
    },
    hashes: {
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      lookupAliasRuntime: 'lookup-alias-runtime-hash',
      lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
      lookupResolverProjection: 'lookup-resolver-projection-hash',
      lookupEntityProjection: 'lookup-entity-projection-hash',
      lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
      lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: args.nlMappingsPayloadHash,
      activeLtrModels: 'ltr-hash',
    },
    fieldAvailability: args.fieldAvailability ?? FIELD_AVAILABILITY,
    quality: CANONICAL_QUALITY,
  };
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
    await fs.writeFile(runtimeStatePath, JSON.stringify(makeRuntimeStatePayload({
      dir,
      nlMappingsPath,
      nlMappingsPayloadHash: hashRuntimeNlMappings(nlMappingsPayload),
      activeLtrModels: 1,
    })));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('up');
  });

  it('returns up for core runtime readiness when zero active LTR models are present', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const nlMappingsPayload = { mappings: [{ key: 'full-bodied', canonical: 'full' }] };

    await fs.writeFile(nlMappingsPath, JSON.stringify(nlMappingsPayload));
    await fs.writeFile(runtimeStatePath, JSON.stringify(makeRuntimeStatePayload({
      dir,
      nlMappingsPath,
      nlMappingsPayloadHash: hashRuntimeNlMappings(nlMappingsPayload),
      activeLtrModels: 0,
    })));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('up');
  });

  it('returns down when explicit LTR runtime readiness is requested and no active LTR models are present', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const nlMappingsPayload = { mappings: [{ key: 'full-bodied', canonical: 'full' }] };

    await fs.writeFile(nlMappingsPath, JSON.stringify(nlMappingsPayload));
    await fs.writeFile(runtimeStatePath, JSON.stringify(makeRuntimeStatePayload({
      dir,
      nlMappingsPath,
      nlMappingsPayloadHash: hashRuntimeNlMappings(nlMappingsPayload),
      activeLtrModels: 0,
    })));

    await expect(
      probeSearchSnapshotRuntimeState(runtimeStatePath, { requireActiveLtr: true }),
    ).resolves.toBe('down');
  });

  it('returns down when NL mappings hash does not match runtime state', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');

    await fs.writeFile(nlMappingsPath, JSON.stringify({
      mappings: [{ key: 'full-bodied', canonical: 'full' }],
    }));
    await fs.writeFile(runtimeStatePath, JSON.stringify(makeRuntimeStatePayload({
      dir,
      nlMappingsPath,
      nlMappingsPayloadHash: 'mismatched-hash',
      activeLtrModels: 1,
    })));

    await expect(probeSearchSnapshotRuntimeState(runtimeStatePath)).resolves.toBe('down');
  });

  it('returns down when runtime state omits sensory field availability metrics', async () => {
    const dir = await makeTempDir();
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const nlMappingsPayload = { mappings: [{ key: 'full-bodied', canonical: 'full' }] };

    await fs.writeFile(nlMappingsPath, JSON.stringify(nlMappingsPayload));
    await fs.writeFile(runtimeStatePath, JSON.stringify(makeRuntimeStatePayload({
      dir,
      nlMappingsPath,
      nlMappingsPayloadHash: hashRuntimeNlMappings(nlMappingsPayload),
      activeLtrModels: 1,
      fieldAvailability: {
        appellation: FIELD_AVAILABILITY.appellation,
      },
    })));

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
    mockLoadSearchSnapshotRuntimeState.mockResolvedValue({
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'abc123',
      quality: CANONICAL_QUALITY,
      counts: {
        activeLtrModels: 1,
      },
    });

    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {
      pool: {
        query: async () => ({
          rows: [{ active_snapshot_id: 'search-snapshot:v1:test', content_hash: 'abc123' }],
        }),
      } as never,
    });

    await expect(health.readiness?.search_snapshot_runtime?.check?.()).resolves.toBe('up');
    expect(mockLoadSearchSnapshotRuntimeState).toHaveBeenCalledTimes(1);
    expect(mockVerifySearchSnapshotRuntimeStateLive).not.toHaveBeenCalled();
  });

  it('allows an active-LTR-zero runtime to pass search_snapshot_runtime when the isolated override is set', async () => {
    mockLoadSearchSnapshotRuntimeState.mockResolvedValue({
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'abc123',
      quality: CANONICAL_QUALITY,
      counts: {
        activeLtrModels: 0,
      },
    });

    const config = parseEnv({
      NODE_ENV: 'test',
      SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME: 'false',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {
      pool: {
        query: async () => ({
          rows: [{ active_snapshot_id: 'search-snapshot:v1:test', content_hash: 'abc123' }],
        }),
      } as never,
    });

    await expect(health.readiness?.search_snapshot_runtime?.check?.()).resolves.toBe('up');
    expect(mockLoadSearchSnapshotRuntimeState).toHaveBeenCalledTimes(1);
    expect(mockVerifySearchSnapshotRuntimeStateLive).not.toHaveBeenCalled();
  });

  it('keeps search_snapshot_runtime up but marks search_snapshot_ltr down when no pool is available and no active LTR exists', async () => {
    mockLoadSearchSnapshotRuntimeState.mockResolvedValue({
      quality: CANONICAL_QUALITY,
      counts: {
        activeLtrModels: 0,
      },
    });

    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });

    const health = buildHealthRouteOptions(config, {});

    await expect(health.readiness?.search_snapshot_runtime?.check?.()).resolves.toBe('up');
    await expect(health.readiness?.search_snapshot_ltr?.check?.()).rejects.toThrow(
      /Active LTR runtime count is zero/,
    );
    expect(health.readiness?.search_snapshot_ltr?.required).toBe(false);
  });

  it('surfaces an unloaded drinking-window predictor as a degraded readiness check', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, {
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
    expect(() => health.readiness?.drinking_window_model?.check?.()).toThrow(
      /drinking window predictor unloaded/,
    );
  });

  it('accepts deterministic drinking-window predictors as a healthy readiness check', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const health = buildHealthRouteOptions(config, {}, {
      modelVersion: 'deterministic:structural-slot-v2',
      predict: () => ({
        drinkingWindowStart: 2020,
        drinkingWindowEnd: 2030,
        peakYear: 2025,
        confidence: 'medium',
        modelVersion: 'deterministic:structural-slot-v2',
      }),
    });

    expect(health.readiness?.drinking_window_model?.check?.()).toBe('up');
  });

  it('omits runtime LTR artifact readiness while live LTR serving is disabled', async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, 'runtime-ltr-models.json');
    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: missingPath,
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.runtime_ltr_artifact).toBeUndefined();
  });

  it('does not register runtime LTR artifact readiness even when reranker is configured', async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, 'runtime-ltr-models.json');
    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: missingPath,
      COHERE_API_KEY: 'co-test-key',
    });

    const health = buildHealthRouteOptions(config, {});

    expect(health.readiness?.runtime_ltr_artifact).toBeUndefined();
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
            { column_name: 'provenance_schema_version' },
            { column_name: 'corpus_id' },
            { column_name: 'corpus_hash' },
            { column_name: 'runtime_target' },
            { column_name: 'uses_live_api' },
            { column_name: 'smoke_synthesized' },
            { column_name: 'threshold_source' },
            { column_name: 'gate_eligible' },
            { column_name: 'suite_gate_passed' },
            { column_name: 'readiness_passed' },
            { column_name: 'active_ltr_models' },
            { column_name: 'label_tier_mix' },
            { column_name: 'slice_mix' },
            { column_name: 'query_class_mix' },
            { column_name: 'runtime_activation_status' },
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
    expect(query.mock.calls.some(([text]) => text.includes('INSERT INTO eval_benchmark_runs'))).toBe(false);
    expect(query.mock.calls.some(([text]) => text.includes('BEGIN'))).toBe(false);
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
