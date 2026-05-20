import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { buildRuntimeSupportServices } from '../container-runtime-support.js';
import { parseEnv } from '../env.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import {
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
} from '../../domain/ranking/service/lambdamart-ranker.js';

function makeWeights(seed: number): number[] {
  return Array.from({ length: LTR_FEATURE_DIMENSION }, (_, index) => Number(((seed + index) / 100).toFixed(2)));
}

describe('buildRuntimeSupportServices', () => {
  beforeEach(() => {
    // Clear the global registry between tests so CB registration assertions
    // are not polluted by registrations from prior tests in the same run.
    globalCircuitBreakerRegistry.clear?.();
  });

  it('W2-BUG-03: registers redis circuit breaker in globalCircuitBreakerRegistry when redisClient is provided', async () => {
    const config = parseEnv({ NODE_ENV: 'test' });

    // Minimal fake Redis client — ping is called once at startup.
    const fakeRedis = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
      ping: async () => 'PONG',
    };

    await buildRuntimeSupportServices(config, { redisClient: fakeRedis as never });

    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).toContain('redis');
  });

  it('W2-BUG-03: does NOT register redis circuit breaker when redisClient is absent', async () => {
    const config = parseEnv({ NODE_ENV: 'test' });

    await buildRuntimeSupportServices(config, {});

    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).not.toContain('redis');
  });

  it('initializes default OpenAI injection judge with in-memory cache when Redis is unavailable', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'sk-test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.injectionJudge).toBeDefined();
    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).toContain('openai-injection-classifier');
  });

  it('initializes Anthropic injection judge only when selected explicitly', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LLM_INJECTION_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.injectionJudge).toBeDefined();
    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).toContain('anthropic-injection-classifier');
  });

  it('initializes OpenAI injection judge when OpenAI provider is selected', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LLM_INJECTION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_CHAT_MODEL: 'gpt-5.4-mini',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.injectionJudge).toBeDefined();
    const names = globalCircuitBreakerRegistry.snapshot().map((s) => s.name);
    expect(names).toContain('openai-injection-classifier');
  });

  it('initializes OpenAI injection judge from OPENAI_API_KEYS when legacy key is absent', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LLM_INJECTION_PROVIDER: 'openai',
      OPENAI_API_KEYS: 'sk-a,sk-b',
      OPENAI_CHAT_MODEL: 'gpt-5.4-mini',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.injectionJudge).toBeDefined();
    expect(config.openai.apiKey).toBe('sk-a');
  });


  it('creates a deterministic drinking-window predictor when no ONNX override is configured', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.drinkingWindowPredictor.modelVersion).toMatch(/^deterministic:/);
    expect(services.runtimeReadiness.drinkingWindowPredictor).toEqual(
      expect.objectContaining({
        configured: true,
        loaded: true,
        modelVersion: services.drinkingWindowPredictor.modelVersion,
      }),
    );
  });

  it('does NOT instantiate phraseCache when Redis is unavailable', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      LLM_QUERY_INTERPRETER: 'true',
      OPENAI_API_KEY: 'sk-test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.phraseCache).toBeUndefined();
  });

  it('does NOT instantiate phraseCache when LLM_QUERY_INTERPRETER is disabled', async () => {
    const config = parseEnv({ NODE_ENV: 'test' });

    // We can't easily inject a real Redis client in this unit lane, but the
    // gate's first conjunct (llmQueryInterpreter) must be enough to skip.
    const services = await buildRuntimeSupportServices(config, {});

    expect(services.phraseCache).toBeUndefined();
  });

  it('fails startup when an explicit ONNX override directory cannot be loaded', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      DRINKING_WINDOW_MODEL_DIR: '/tmp/definitely-missing-drinking-window-model',
    });

    await expect(buildRuntimeSupportServices(config, {})).rejects.toBeDefined();
  });

  it('keeps runtime LTR artifact disabled even when a local file is configured', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-support-'));
    const modelPath = path.join(tempDir, 'runtime-ltr-models.json');
    const artifact = {
      queryClassModels: {
        red_wine: {
          weights: makeWeights(10),
          bias: 0.12,
          featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
          trainingExampleCount: 33,
          ndcg5ValidationScore: 0.72,
          trainedAt: '2026-04-01T00:00:00.000Z',
        },
      },
    };
    await writeFile(modelPath, JSON.stringify(artifact, null, 2));

    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: modelPath,
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.runtimeLtrArtifact).toEqual(
      expect.objectContaining({
        configured: true,
        loaded: false,
        issue: 'disabled',
      }),
    );
    expect(services.runtimeReadiness.ltrModels.effective).toEqual(
      expect.objectContaining({
        source: 'none',
        loaded: false,
        modelCount: 0,
        issue: 'disabled',
        required: false,
      }),
    );
    expect(services.runtimeReadiness.ltrModels.artifact).toEqual(
      expect.objectContaining({
        configured: false,
        loaded: false,
        selected: false,
        issue: 'disabled',
      }),
    );
    await rm(tempDir, { recursive: true, force: true });
  });

  it('surfaces a missing runtime LTR artifact in the typed readiness snapshot without failing startup', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-missing-'));
    const missingPath = path.join(tempDir, 'runtime-ltr-models.json');

    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: missingPath,
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.runtimeReadiness.runtimeLtrArtifact).toEqual(
      expect.objectContaining({
        configured: true,
        loaded: false,
        issue: 'disabled',
      }),
    );
    expect(services.ltrModels).toBeUndefined();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('marks benchmark persistence unavailable when the eval startup gate is enabled but no PG pool exists', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      EVAL_RUN_AT_STARTUP: 'true',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.runtimeReadiness.benchmarkPersistence).toEqual(
      expect.objectContaining({
        configured: true,
        available: false,
        issue: 'pg_pool_missing',
      }),
    );
  });

  it('does not query PG or select runtime artifacts while LTR serving is disabled', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-support-'));
    const modelPath = path.join(tempDir, 'runtime-ltr-models.json');
    const artifact = {
      queryClassModels: {
        red_wine: {
          queryClass: 'ignored',
          weights: makeWeights(30),
          bias: 0.2,
          featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
          trainingExampleCount: 12,
          ndcg5ValidationScore: 0.7,
          trainedAt: '2026-04-01T00:00:00Z',
        },
      },
    };
    await writeFile(modelPath, JSON.stringify(artifact, null, 2));

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as never;
    const config = parseEnv({
      NODE_ENV: 'test',
      RUNTIME_LTR_MODELS_PATH: modelPath,
    });

    const services = await buildRuntimeSupportServices(config, { pool });

    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.effective).toEqual(
      expect.objectContaining({
        source: 'none',
        loaded: false,
        modelCount: 0,
        issue: 'disabled',
        required: false,
      }),
    );
    expect(services.runtimeReadiness.ltrModels.artifact.selected).toBe(false);
    expect(services.runtimeReadiness.ltrModels.registry).toEqual(
      expect.objectContaining({
        configured: false,
        loaded: false,
        issue: 'disabled',
      }),
    );
    expect(pool.query).not.toHaveBeenCalled();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips snapshot-bound registry lookup entirely while LTR serving is disabled', async () => {
    const activeSnapshotId = 'search-snapshot:v1:active-serving';
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('active_search_snapshot')) {
        return {
          rows: [{
            active_snapshot_id: activeSnapshotId,
            previous_snapshot_id: null,
            content_hash: 'content-hash',
            promoted_at: new Date('2026-04-01T00:00:00Z'),
          }],
        };
      }
      if (sql.includes('ltr_model_registry')) {
        expect(params).toEqual([activeSnapshotId]);
        return {
          rows: [{
            registry_id: 'ltr-registry-id',
            query_class: 'semantic_preference',
            model_version: 7,
            is_active: true,
            search_snapshot_id: activeSnapshotId,
            eval_dataset_version: 'eval-v1',
            feature_schema_hash: 'feature-hash',
            copied_from_registry_id: null,
            copied_from_snapshot_id: null,
            weights: [0.2, 0.1, -0.05, 0.2, 0.15, 0.03, 0.08, 0.27],
            bias: 0.12,
            training_example_count: 33,
            ndcg5_validation_score: 0.72,
            trained_at: new Date('2026-04-01T00:00:00Z'),
            created_at: new Date('2026-04-01T00:00:00Z'),
          }],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as never;
    const config = parseEnv({ NODE_ENV: 'test' });

    const services = await buildRuntimeSupportServices(config, { pool });

    expect(services.ltrModels).toBeUndefined();
    expect(services.runtimeReadiness.ltrModels.registry).toEqual(
      expect.objectContaining({
        configured: false,
        loaded: false,
        issue: 'disabled',
      }),
    );
    expect(services.runtimeReadiness.ltrModels.effective).toEqual(
      expect.objectContaining({
        source: 'none',
        loaded: false,
        modelCount: 0,
        issue: 'disabled',
        required: false,
      }),
    );
    expect(query).not.toHaveBeenCalled();
  });
});
