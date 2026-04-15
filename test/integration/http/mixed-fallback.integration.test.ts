import { describe, expect, it } from 'vitest';
import { createServer } from '../../../src/interface/http/server.js';
import { createTestContainer } from '../helpers/test-container.js';
import { CLOUDY_BAY_ID } from '../helpers/test-fixtures.js';

describe('HTTP /v1/search — mixed empty-result fallback', () => {
  it('recovers mixed zero-candidate results via constraint-guided hybrid without reapplying anchor-relative filtering', async () => {
    const parts = createTestContainer();
    parts.similarRetrieval.setResults(CLOUDY_BAY_ID, []);

    const app = await createServer(parts.container, {
      logLevel: 'error',
      nodeEnv: 'test',
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: '클라우디베이 말고 다른 화이트',
          options: { mode: 'auto', explain: false, clarification: false },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        results?: readonly { entity_id?: string }[];
        meta?: { route?: string; degradation_reasons?: readonly string[] };
        engine_decision?: { degradation_reasons?: readonly string[] };
      }>();

      expect(body.meta?.route).toMatch(/^(mixed|hybrid)$/);
      expect(body.results?.length ?? 0).toBeGreaterThan(0);
      expect(body.results?.map((result) => result.entity_id)).not.toContain(CLOUDY_BAY_ID);
      expect([
        ...(body.meta?.degradation_reasons ?? []),
        ...(body.engine_decision?.degradation_reasons ?? []),
      ]).toContain('mixed_constraint_guided_hybrid_fallback');
    } finally {
      await app.close();
    }
  });
});
