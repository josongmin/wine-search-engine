/**
 * Rule-22 consistency: the agent request schema's `agent_timeout_ms` upper
 * bound must equal the Fastify server `requestTimeout`. The server hard-kills
 * any request past that budget, so a larger schema max would let clients
 * request a timeout they can never actually get (the historic 120 s vs 30 s
 * mismatch). This test fails the moment the two drift.
 */
import { describe, expect, it } from 'vitest';
import { WineSearchRequestSchema } from '../../../../src/interface/http/schemas/wine-search.schema.js';
import { HTTP_DEFAULT_REQUEST_TIMEOUT_MS } from '../../../../src/interface/http/constants.js';

describe('wine-search agent_timeout_ms ↔ server requestTimeout consistency', () => {
  it('accepts agent_timeout_ms exactly at the server request timeout', () => {
    const parsed = WineSearchRequestSchema.safeParse({
      query: 'Opus One',
      options: { agent_timeout_ms: HTTP_DEFAULT_REQUEST_TIMEOUT_MS },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects agent_timeout_ms above the server request timeout (unachievable)', () => {
    const parsed = WineSearchRequestSchema.safeParse({
      query: 'Opus One',
      options: { agent_timeout_ms: HTTP_DEFAULT_REQUEST_TIMEOUT_MS + 1 },
    });
    expect(parsed.success).toBe(false);
  });
});
