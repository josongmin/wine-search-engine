import { describe, expect, it } from 'vitest';
import { buildRuntimeSupportServices } from '../container-runtime-support.js';
import { parseEnv } from '../env.js';

describe('buildRuntimeSupportServices', () => {
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
    });

    await expect(buildRuntimeSupportServices(config, {})).rejects.toThrow(/heuristic-only drinking-window/);
  });

  it('allows heuristic drinking-window predictor in production only with explicit config opt-in', async () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      ALLOW_HEURISTIC_DRINKING_WINDOW: 'true',
    });

    const services = await buildRuntimeSupportServices(config, {});

    expect(services.drinkingWindowPredictor.modelVersion).toContain('heuristic');
  });

  it('fails startup when an explicit drinking-window model directory cannot be loaded', async () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      DRINKING_WINDOW_MODEL_DIR: '/tmp/definitely-missing-drinking-window-model',
    });

    await expect(buildRuntimeSupportServices(config, {})).rejects.toBeDefined();
  });
});
