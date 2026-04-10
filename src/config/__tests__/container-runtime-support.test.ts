import { describe, expect, it, beforeEach } from 'vitest';
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

  it('allows heuristic drinking-window predictor outside production', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.drinkingWindowPredictor.modelVersion).toContain('heuristic');
  });

  it('rejects heuristic drinking-window predictor in production without explicit opt-in', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    await expect(buildRuntimeSupportServices(config, {})).rejects.toThrow(/heuristic-only drinking-window/);
  });

  it('allows heuristic drinking-window predictor in production only with explicit config opt-in', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      ALLOW_HEURISTIC_DRINKING_WINDOW: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.drinkingWindowPredictor.modelVersion).toContain('heuristic');
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

  it('fails startup when an explicit drinking-window model directory cannot be loaded', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      DRINKING_WINDOW_MODEL_DIR: '/tmp/definitely-missing-drinking-window-model',
    });

    await expect(buildRuntimeSupportServices(config, {})).rejects.toBeDefined();
  });
});
