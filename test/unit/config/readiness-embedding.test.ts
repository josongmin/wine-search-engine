/**
 * E5-T1: W6-P1-2 — embedding readiness fails closed when no OpenAI key.
 *
 * Fix: required dense retrieval probe must not hide unavailable embedding support
 * behind `skipped`; it must report `down` so `/ready` fails closed.
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
    cohere: {},
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

describe('E5-T1: embedding readiness when no OpenAI key', () => {
  it('returns down when no openai.apiKey', async () => {
    const config = makeMinimalConfig();
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    expect(status).toBe('down');
  });

  it('returns up when openai.apiKey is set (probe called, mocked as up)', async () => {
    const config = makeMinimalConfig();
    (config.openai as Record<string, unknown>)['apiKey'] = 'sk-test';
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    expect(status).toBe('up');
  });

  it('returns up when openai.apiKeys is set without legacy apiKey', async () => {
    const config = makeMinimalConfig();
    (config.openai as Record<string, unknown>)['apiKeys'] = ['sk-a', 'sk-b'];
    const options = buildHealthRouteOptions(config, makeRuntime());
    const embeddingCheck = options.readiness['embedding'];
    expect(embeddingCheck).toBeDefined();
    const status = await embeddingCheck!.check();
    expect(status).toBe('up');
  });
});
