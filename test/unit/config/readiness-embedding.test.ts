/**
 * E5-T1: W6-P1-2 — embedding readiness returns 'skipped' when URL missing.
 *
 * Fix: URL 없음 = probe 불가 상태이므로 'down'(서비스 장애) 대신 'skipped'(probe 불가)가 정확.
 * 'down' + required:true 조합이 URL 미설정 환경에서 허위 not-ready를 보고했던 버그 수정.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../../../src/config/env.js';
import type { RuntimeHandles } from '../../../src/config/runtime-handles.js';
import { buildHealthRouteOptions } from '../../../src/config/readiness.js';

vi.mock('../../../src/infrastructure/health/readiness-probes.js', () => ({
  probeJsonPostEndpoint: vi.fn().mockResolvedValue('up'),
}));

vi.mock('../../../src/config/bootstrap-logger.js', () => ({
  bootstrapLogger: {
    child: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/config/watchlist.js', () => ({
  expectsRedisAtStartup: () => false,
  isWatchlistEnabled: () => false,
}));

function makeMinimalConfig(overrides: Partial<Config['embedding']> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 3000,
    host: '0.0.0.0',
    vespa: { url: 'http://vespa:8080' },
    openai: {},
    embedding: { model: 'test-model', ...overrides },
    learnedMatcher: {},
    reranker: {},
    killSwitch: { denseRetrieval: false },
    redis: {},
    postgres: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test' },
    watchlist: { enabled: false },
    rateLimiting: {},
    auth: {},
    telemetry: {},
  } as unknown as Config;
}

function makeRuntime(): RuntimeHandles {
  return {} as unknown as RuntimeHandles;
}

describe('E5-T1: embedding readiness when URL missing', () => {
  it('returns skipped when no openai.apiKey and no embedding.url', async () => {
    const config = makeMinimalConfig({ url: undefined });
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    // W6-P1-2 fix: URL 없음 = probe 불가 → 'skipped'. 'down'은 서비스가 실제로 응답 실패할 때
    // 사용하며, URL 자체가 없는 경우 (미설정 환경)에서는 'skipped'가 정확한 상태입니다.
    // required:true + 'down' 조합이 URL 미설정 환경에서 서버를 허위 not-ready로 표시했던 버그 수정.
    expect(status).toBe('skipped');
  });

  it('returns up when openai.apiKey is set (falls through to openai check, mocked as up)', async () => {
    const config = makeMinimalConfig({ url: undefined });
    (config.openai as Record<string, unknown>)['apiKey'] = 'sk-test';
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    // Mocked probeJsonPostEndpoint returns 'up'
    expect(status).toBe('up');
  });

  it('returns up when embedding.url is set (probe called, mocked as up)', async () => {
    const config = makeMinimalConfig({ url: 'http://embedding:5000' });
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    expect(status).toBe('up');
  });
});
