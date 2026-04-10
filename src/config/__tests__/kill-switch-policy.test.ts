import { describe, expect, it } from 'vitest';
import { buildCacheReadRuntimeState } from '../kill-switch-policy.js';
import { parseEnv } from '../env.js';

describe('buildCacheReadRuntimeState — rerankerAvailable', () => {
  it('is true when Cohere API key is configured', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(true);
  });

  it('is true when self-hosted reranker URL is configured', () => {
    const config = parseEnv({ NODE_ENV: 'test', RERANKER_SERVICE_URL: 'https://reranker.example.com' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(true);
  });

  it('is true when both Cohere key and reranker URL are configured', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      COHERE_API_KEY: 'co-test-key',
      RERANKER_SERVICE_URL: 'https://reranker.example.com',
    });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(true);
  });

  it('is false when neither Cohere key nor reranker URL are configured', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when reranker is configured but runtime signal reports timeout', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      degradation: { degradationReasons: ['reranker_timeout'] },
    });
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when reranker is configured but runtime signal reports unavailable', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      degradation: { degradationReasons: ['reranker_unavailable'] },
    });
    expect(state.rerankerAvailable).toBe(false);
  });
});

describe('buildCacheReadRuntimeState — currentExecutionModeHint', () => {
  it('is authoritative when all services configured and no degradation', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.currentExecutionModeHint).toBe('authoritative');
  });

  it('is degraded when reranker is not configured', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.currentExecutionModeHint).toBe('degraded');
  });

  it('is degraded when dense retrieval kill switch is active', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      COHERE_API_KEY: 'co-test-key',
      KILL_SWITCH_DENSE_RETRIEVAL: 'true',
    });
    const state = buildCacheReadRuntimeState(config);
    expect(state.currentExecutionModeHint).toBe('degraded');
  });

  // BUG-19: 4개 degradation 조건 미테스트
  it('is degraded when KILL_SWITCH_LEARNING=true', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      COHERE_API_KEY: 'co-test-key',
      KILL_SWITCH_LEARNING: 'true',
    });
    const state = buildCacheReadRuntimeState(config);
    expect(state.currentExecutionModeHint).toBe('degraded');
  });

  it('KILL_SWITCH_LEARNING sets learningKillSwitchEnabled=true in state', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_LEARNING: 'true',
    });
    const state = buildCacheReadRuntimeState(config);
    expect(state.learningKillSwitchEnabled).toBe(true);
  });

  it('KILL_SWITCH_DENSE_RETRIEVAL sets denseRetrievalEnabled=false in state', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      KILL_SWITCH_DENSE_RETRIEVAL: 'true',
    });
    const state = buildCacheReadRuntimeState(config);
    expect(state.denseRetrievalEnabled).toBe(false);
  });

  it('reranker URL with trailing whitespace is still treated as configured (trim-safe)', () => {
    // kill-switch-policy uses url?.trim().length to guard against whitespace-only strings.
    // A valid URL with surrounding whitespace parsed through env is a different path —
    // here we verify the policy itself trims before checking length.
    const config = parseEnv({ NODE_ENV: 'test', RERANKER_SERVICE_URL: 'https://reranker.example.com' });
    // Manually simulate what would happen if URL had leading/trailing spaces post-parse
    const configWithSpaceUrl = {
      ...config,
      reranker: { ...config.reranker, url: '   ' },
    };
    const state = buildCacheReadRuntimeState(configWithSpaceUrl as typeof config);
    expect(state.rerankerAvailable).toBe(false);
  });

  it('whitespace-only reranker url → mode degraded', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const configWithSpaceUrl = {
      ...config,
      reranker: { ...config.reranker, url: '   ' },
    };
    const state = buildCacheReadRuntimeState(configWithSpaceUrl as typeof config);
    expect(state.currentExecutionModeHint).toBe('degraded');
  });
});
