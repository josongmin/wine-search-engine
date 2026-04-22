import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { buildRuntimeSupportServices } from '../container-runtime-support.js';
import { parseEnv } from '../env.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';

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

  it('initializes injection judge with in-memory cache when Redis is unavailable', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'sk-test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.injectionJudge).toBeDefined();
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

  it('loads LTR models from local runtime artifact when PG is unavailable', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-support-'));
    const modelPath = path.join(tempDir, 'runtime-ltr-models.json');
    const artifact = {
      queryClassModels: {
        red_wine: {
          weights: [0.2, 0.1, -0.05, 0.2, 0.15, 0.03, 0.08, 0.27],
          bias: 0.12,
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

    expect(services.ltrModels).toBeDefined();
    expect(services.ltrModels?.size).toBe(1);
    expect(services.ltrModels?.get('red_wine')).toBeDefined();
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
        issue: 'missing_or_invalid',
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

  it('falls back to local runtime artifact when PG returns zero models', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-support-'));
    const modelPath = path.join(tempDir, 'runtime-ltr-models.json');
    const artifact = {
      queryClassModels: {
        red_wine: {
          queryClass: 'ignored',
          weights: [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88],
          bias: 0.2,
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

    expect(services.ltrModels).toBeDefined();
    expect(services.ltrModels?.size).toBe(1);
    expect(services.ltrModels?.get('red_wine')).toBeDefined();
    expect(pool.query).toHaveBeenCalled();
    await rm(tempDir, { recursive: true, force: true });
  });
});
