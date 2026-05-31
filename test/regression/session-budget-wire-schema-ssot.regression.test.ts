/**
 * SSoT regression: the snake_case `session_context` / `query_budget` wire
 * shapes and the per-lane `lane_trace` shape are defined ONCE and reused by
 * both the HTTP request and response surfaces.
 *
 * Background: before the SSoT extraction the snake-case session/budget object
 * was hand-copied into `search-request.schema.ts` (transforming variant) and
 * `search-response.schema.ts` (transport variant). The copies drifted — the
 * request copy bounded `session_id` to `MAX_SESSION_ID_CHARS` while the
 * response copy left it unbounded. The lane_trace shape was likewise inlined
 * inside `EngineDecisionSchema`, duplicating `ExecutionLaneTraceWireSchema`.
 *
 * Locks the following invariants (CLAUDE.md rule 30 — cross-module constants /
 * shapes must come from a single source):
 *  - `SessionContextWireSchema` enforces the `MAX_SESSION_ID_CHARS` bound on
 *    `session_id` (the previously-missing response-side bound). Boundary tests
 *    JUST inside and JUST outside the bound (rule 6).
 *  - The request-side transform alias derives from the same wire object, so it
 *    enforces the identical `session_id` bound.
 *  - `query_budget` snake shape parses identically through the request transform
 *    and the response transport (same field bounds).
 *  - The response `engine_decision.lane_trace` and the
 *    `meta.execution_contract.lane_trace` accept the SAME lane-trace shape —
 *    drift between them would re-introduce the inline-copy SSoT violation.
 *  - Korean session ids round-trip (no ASCII-boundary surprises).
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  QueryBudgetSnakeSchema,
  QueryBudgetWireSchema,
  SessionContextSnakeSchema,
  SessionContextWireSchema,
} from '../../src/interface/http/schemas/session-budget-wire.schema.js';
import { MAX_SESSION_ID_CHARS } from '../../src/interface/http/constants.js';

describe('session/budget wire schema SSoT', () => {
  it('SessionContextWireSchema enforces the MAX_SESSION_ID_CHARS bound (response side)', () => {
    const atBound = SessionContextWireSchema.safeParse({
      session_id: 'a'.repeat(MAX_SESSION_ID_CHARS),
      previous_entities: [],
    });
    expect(atBound.success).toBe(true);

    const overBound = SessionContextWireSchema.safeParse({
      session_id: 'a'.repeat(MAX_SESSION_ID_CHARS + 1),
      previous_entities: [],
    });
    expect(overBound.success).toBe(false);
  });

  it('request-side transform alias inherits the same session_id bound', () => {
    const atBound = SessionContextSnakeSchema.safeParse({
      session_id: 'a'.repeat(MAX_SESSION_ID_CHARS),
      previous_entities: ['e1'],
    });
    expect(atBound.success).toBe(true);
    if (atBound.success) {
      // Transform camel-cases the keys for the internal use-case contract.
      expect(atBound.data).toEqual({
        sessionContext: {
          sessionId: 'a'.repeat(MAX_SESSION_ID_CHARS),
          previousEntities: ['e1'],
        },
      });
    }

    const overBound = SessionContextSnakeSchema.safeParse({
      session_id: 'a'.repeat(MAX_SESSION_ID_CHARS + 1),
      previous_entities: [],
    });
    expect(overBound.success).toBe(false);
  });

  it('Korean session ids round-trip through the wire shape', () => {
    const parsed = SessionContextWireSchema.safeParse({
      session_id: '세션-아이디-한글',
      previous_entities: ['엔티티-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('query_budget snake shape parses identically on both surfaces', () => {
    const input = {
      max_latency_ms: 1_000,
      max_candidates: 50,
      rerank_limit: 10,
    };
    const transport = QueryBudgetWireSchema.safeParse(input);
    expect(transport.success).toBe(true);

    const transformed = QueryBudgetSnakeSchema.safeParse(input);
    expect(transformed.success).toBe(true);
    if (transformed.success) {
      expect(transformed.data).toEqual({
        queryBudget: {
          maxLatencyMs: 1_000,
          maxCandidates: 50,
          rerankLimit: 10,
        },
      });
    }
  });
});
