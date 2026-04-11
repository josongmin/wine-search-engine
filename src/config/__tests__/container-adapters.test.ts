import { describe, expect, it } from 'vitest';
import { buildCoreAdapterServices } from '../container-adapters.js';
import { parseEnv } from '../env.js';
import { CohereReranker } from '../../infrastructure/ai/cohere-reranker.js';

describe('buildCoreAdapterServices', () => {
  it('rejects stub-backed core adapters in production without PostgreSQL', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    expect(() => buildCoreAdapterServices(config, {})).toThrowError(/PostgreSQL-backed adapters/);
  });

  it('still allows local stub-backed adapters outside production', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    expect(() => buildCoreAdapterServices(config, {})).not.toThrow();
  });

  it('wires CohereReranker when COHERE_API_KEY is set', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
      COHERE_API_KEY: 'co-test',
      COHERE_RERANK_MODEL: 'rerank-v4.0-pro',
    });

    const adapters = buildCoreAdapterServices(config, {});

    expect(adapters.reranker).toBeInstanceOf(CohereReranker);
  });

  it('leaves reranker undefined when COHERE_API_KEY is not set', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      WEBHOOK_SECRET: 'watchlist-secret-1234',
    });

    const adapters = buildCoreAdapterServices(config, {});

    expect(adapters.reranker).toBeUndefined();
  });
});
