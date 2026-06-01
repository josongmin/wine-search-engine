/**
 * RFC-021 T-PSA-04 — fail-closed regression rail for the AGENT reference-
 * similarity composition (`lookup_wine` → `similar_to_entity`).
 *
 * This rail exists because the live "오푸스원 비슷한 와인" regression was not
 * caught early by any owner-local gate. It locks the structural invariants that
 * prevent the two regression classes the ticket names:
 *
 *   1. ANCHOR LOSS — a free-text name smuggled back into the similarity
 *      primitive (which would force an internal re-resolution and lose the
 *      resolved entity). Covered by: entity_id is the only accepted anchor;
 *      query / anchor_name / anchor_query / mode / retrieval_mode are rejected,
 *      for BOTH Korean and English surface forms.
 *   2. SAME-ENTITY LEAKAGE — the anchor wine appearing in its own similarity
 *      results. Covered structurally here: the primitive plan fixes
 *      retrievalMode='similar_items', which is the ONLY mode that triggers the
 *      mixed solver's seed-exclusion + producer-diversity core
 *      (`applySetConstraintsForSimilarItems`, proven in
 *      `test/unit/domain/mixed/mixed-solver.test.ts`). If this rail's plan ever
 *      stops emitting 'similar_items', exclusion silently disappears.
 *
 * Append-only (CLAUDE.md): never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSimilarToEntityInput,
} from '../../src/application/search/reference-similarity-execution.js';
import {
  buildSimilarToEntityPrimitivePlan,
} from '../../src/application/search/search-usecase-caller-controlled-plan.js';
import { mapSearchUseCaseInputToSearchRequest } from '../../src/application/wine-search/adapters/search-use-case-adapter.js';
import { WINE_AGENT_LOOP_TOOL_NAMES } from '../../src/application/wine-search/wine-agent-loop-tool-bundle.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { SearchRequest } from '../../src/application/search/search-request.dto.js';

describe('reference-similarity agent rail — anchor authority is entity_id (anchor-loss guard)', () => {
  // The anchor is ALWAYS a resolved entity_id. A name — in any language — must
  // be refused so the agent is forced through lookup_wine first.
  it.each([
    ['english query', { entity_id: 'opus-one-2018', query: 'Opus One 2018' }],
    ['korean query', { entity_id: 'opus-one-2018', query: '오푸스원' }],
    ['english anchor_name', { entity_id: 'opus-one-2018', anchor_name: 'Opus One' }],
    ['korean anchor_name', { entity_id: 'opus-one-2018', anchor_name: '오푸스원' }],
    ['anchor_query', { entity_id: 'opus-one-2018', anchor_query: 'wines like opus one' }],
    ['lane override mode', { entity_id: 'opus-one-2018', mode: 'mixed' }],
    ['lane override retrieval_mode', { entity_id: 'opus-one-2018', retrieval_mode: 'mixed' }],
  ])('rejects a free-text anchor / lane override: %s', (_label, input) => {
    expect(normalizeSimilarToEntityInput(input).ok).toBe(false);
  });

  it('accepts a bare entity_id anchor (the only valid anchor form)', () => {
    const result = normalizeSimilarToEntityInput({ entity_id: 'opus-one-2018' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entityId).toBe('opus-one-2018');
  });

  it('compiles an anchor + price/style residual without re-exposing a free-text anchor', () => {
    const result = normalizeSimilarToEntityInput({
      entity_id: 'opus-one-2018',
      max_price_krw: 80_000,
      style: 'approachable',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The residual lands in structured constraint bundles, never as free text.
    const allConstraints = [...result.filters, ...result.preferences];
    expect(allConstraints.length).toBeGreaterThan(0);
  });
});

describe('reference-similarity agent rail — same-entity-exclusion lane is wired', () => {
  function similarRequest(): SearchRequest {
    return {
      query: 'opus-one-2018',
      primitiveRoute: 'similar_to_entity',
      anchorEntityId: createCanonicalEntityId('opus-one-2018'),
    };
  }

  it('fixes retrievalMode=similar_items (the only mode that triggers seed exclusion)', () => {
    const { plan, compiled } = buildSimilarToEntityPrimitivePlan(similarRequest(), 'opus-one-2018');
    expect(plan.retrievalMode).toBe('similar_items');
    expect(compiled.execution.effectiveRetrievalMode).toBe('similar_items');
    expect(compiled.execution.effectiveRoute).toBe('mixed');
  });

  it('seeds the anchor by entity_id (source=entity_lookup), not by free-text extraction', () => {
    const { plan } = buildSimilarToEntityPrimitivePlan(similarRequest(), 'opus-one-2018');
    expect(plan.anchors[0]?.candidateEntityIds).toEqual([
      createCanonicalEntityId('opus-one-2018'),
    ]);
    expect(plan.anchors[0]?.source).toBe('entity_lookup');
  });
});

describe('reference-similarity agent rail — chain integrity', () => {
  it('exposes similar_to_entity in the active agent tool taxonomy', () => {
    expect(WINE_AGENT_LOOP_TOOL_NAMES).toContain('similar_to_entity');
  });

  it('maps a resolved anchor onto the path-authoritative similar_to_entity route (no callerInterpretation drift)', () => {
    const req = mapSearchUseCaseInputToSearchRequest({
      query: 'opus-one-2018',
      anchorEntityId: 'opus-one-2018',
    });
    expect(req.primitiveRoute).toBe('similar_to_entity');
    expect(req.anchorEntityId).toBe('opus-one-2018');
    expect(req.callerInterpretation).toBeUndefined();
  });
});
