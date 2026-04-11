import { describe, expect, it } from 'vitest';
import { buildCacheReadRuntimeState } from '../kill-switch-policy.js';
import { parseEnv } from '../env.js';

describe('buildCacheReadRuntimeState — rerankerAvailable', () => {
  it('is true when Cohere API key is configured', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(true);
  });

  it('is false when COHERE_API_KEY is not set', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    const state = buildCacheReadRuntimeState(config);
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when reranker is configured but runtime signal reports timeout', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'failed',
      degradation: { executionMode: 'degraded', degradationReasons: ['reranker_timeout'] },
    });
    expect(state.rerankerAvailable).toBe(false);
  });

  // 'reranker_unavailable' is NOT a value produced by classifyRerankerFailureReason().
  // The actual values are: reranker_timeout, reranker_http_error, reranker_parse_error,
  // reranker_unknown. This test ensures we don't accidentally rely on the old ghost string.
  it('is true when degradationReasons contains unknown ghost string reranker_unavailable (not produced by ranker)', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'executed',
      degradation: { executionMode: 'degraded', degradationReasons: ['reranker_unavailable'] },
    });
    // 'reranker_unavailable' is not in the whitelist so this alone doesn't mark it unavailable
    expect(state.rerankerAvailable).toBe(true);
  });

  it('is false when rerankerStatus is "failed" (primary SSoT)', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'failed',
    });
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when degradationReasons includes reranker_http_error', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'failed',
      degradation: { executionMode: 'degraded', degradationReasons: ['reranker_http_error'] },
    });
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when degradationReasons includes reranker_parse_error', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'failed',
      degradation: { executionMode: 'degraded', degradationReasons: ['reranker_parse_error'] },
    });
    expect(state.rerankerAvailable).toBe(false);
  });

  it('is false when degradationReasons includes reranker_unknown', () => {
    const config = parseEnv({ NODE_ENV: 'test', COHERE_API_KEY: 'co-test-key' });
    const state = buildCacheReadRuntimeState(config, {
      rerankerStatus: 'failed',
      degradation: { executionMode: 'degraded', degradationReasons: ['reranker_unknown'] },
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
});
