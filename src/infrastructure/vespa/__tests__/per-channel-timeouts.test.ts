/**
 * E3-T5: Per-channel timeout constants test.
 *
 * Verifies that the three named timeout constants are exported, are all
 * positive numbers, and are all distinct (prevents regression to shared timeout).
 *
 * SCAN4-08 parity: also asserts that RetrievalEnvSchema's defaults for
 * EMBEDDING_HTTP_TIMEOUT_MS and RERANKER_HTTP_TIMEOUT_MS equal the SSoT
 * constants from this module, so a future drift is caught at test time.
 */

import { describe, expect, it } from 'vitest';
import {
  VESPA_SEARCH_TIMEOUT_MS,
  EMBEDDING_TIMEOUT_MS,
  RERANKER_TIMEOUT_MS,
} from '../per-channel-timeouts.js';
import { RetrievalEnvSchema } from '../../../config/env-schemas/retrieval.schema.js';

describe('Per-channel timeout constants (E3-T5)', () => {
  it('VESPA_SEARCH_TIMEOUT_MS is a positive finite number', () => {
    expect(typeof VESPA_SEARCH_TIMEOUT_MS).toBe('number');
    expect(Number.isFinite(VESPA_SEARCH_TIMEOUT_MS)).toBe(true);
    expect(VESPA_SEARCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('EMBEDDING_TIMEOUT_MS is a positive finite number', () => {
    expect(typeof EMBEDDING_TIMEOUT_MS).toBe('number');
    expect(Number.isFinite(EMBEDDING_TIMEOUT_MS)).toBe(true);
    expect(EMBEDDING_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('RERANKER_TIMEOUT_MS is a positive finite number', () => {
    expect(typeof RERANKER_TIMEOUT_MS).toBe('number');
    expect(Number.isFinite(RERANKER_TIMEOUT_MS)).toBe(true);
    expect(RERANKER_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('all three constants have distinct values (prevents shared-timeout regression)', () => {
    const values = new Set([VESPA_SEARCH_TIMEOUT_MS, EMBEDDING_TIMEOUT_MS, RERANKER_TIMEOUT_MS]);
    expect(values.size).toBe(3);
  });

  describe('SCAN4-08 SSoT parity — env schema defaults match per-channel-timeouts', () => {
    // Parse without overrides to surface the schema defaults.
    const envDefaults = RetrievalEnvSchema.parse({});

    it('EMBEDDING_HTTP_TIMEOUT_MS env default === EMBEDDING_TIMEOUT_MS', () => {
      expect(envDefaults.EMBEDDING_HTTP_TIMEOUT_MS).toBe(EMBEDDING_TIMEOUT_MS);
    });

    it('RERANKER_HTTP_TIMEOUT_MS env default === RERANKER_TIMEOUT_MS', () => {
      expect(envDefaults.RERANKER_HTTP_TIMEOUT_MS).toBe(RERANKER_TIMEOUT_MS);
    });
  });
});
