import { describe, it, expect } from 'vitest';
import {
  buildSimilarToEntityPrimitivePlan,
  isSimilarToEntityPrimitiveSearchRequest,
} from '../search-usecase-caller-controlled-plan.js';
import type { SearchRequest } from '../search-request.dto.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/entity-id.js';
import type { NormalizedConstraint } from '../../../domain/shared/types/constraint-bundle.js';

/**
 * RFC-021 T-PSA-01 — owner-local proof rail for the caller/path-authoritative
 * `similar_to_entity` execution-plan builder.
 *
 * Structural invariants under test:
 *  - anchor authority is `anchorEntityId`, seeded directly into plan.anchors
 *    with source='entity_lookup' (no free-text extraction)
 *  - route is fixed to `mixed` / retrievalMode `similar_items` so the locked
 *    mixed solver's same-entity-exclusion + producer-diversity core fires
 *  - admission requires identity seal + anchor evidence
 *  - the dedicated SIMILAR_TO_ENTITY_PATH_AUTHORITY reason code is stamped
 */

const ANCHOR = createCanonicalEntityId('opus-one-2018');

function baseRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query: 'opus one',
    primitiveRoute: 'similar_to_entity',
    anchorEntityId: ANCHOR,
    options: { mode: 'auto', explain: false, clarification: false },
    ...overrides,
  };
}

describe('isSimilarToEntityPrimitiveSearchRequest', () => {
  it('is true only when primitiveRoute AND anchorEntityId are both set', () => {
    expect(isSimilarToEntityPrimitiveSearchRequest(baseRequest())).toBe(true);
  });

  it('is false when the anchor is missing (no silent degrade to free-text similarity)', () => {
    const req: SearchRequest = {
      query: 'opus one',
      primitiveRoute: 'similar_to_entity',
    };
    expect(isSimilarToEntityPrimitiveSearchRequest(req)).toBe(false);
  });

  it('is false for a plain (planner) request', () => {
    expect(isSimilarToEntityPrimitiveSearchRequest({ query: 'wines like opus one' })).toBe(false);
  });
});

describe('buildSimilarToEntityPrimitivePlan — anchor + lane authority', () => {
  it('fixes route=mixed and retrievalMode=similar_items', () => {
    const { plan, compiled } = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(plan.route).toBe('mixed');
    expect(plan.retrievalMode).toBe('similar_items');
    expect(compiled.execution.effectiveRoute).toBe('mixed');
    expect(compiled.execution.effectiveRetrievalMode).toBe('similar_items');
  });

  it('classifies the plan as anchored_similarity / mixed_query', () => {
    const { plan } = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(plan.queryClass).toBe('anchored_similarity');
    expect(plan.intent).toBe('mixed_query');
  });

  it('seeds the resolved anchor directly with source=entity_lookup and confidence 1', () => {
    const { plan } = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(plan.anchors).toHaveLength(1);
    const anchor = plan.anchors[0];
    expect(anchor?.candidateEntityIds).toEqual([ANCHOR]);
    expect(anchor?.source).toBe('entity_lookup');
    expect(anchor?.confidence).toBe(1);
  });

  it('stamps the dedicated path-authority reason code', () => {
    const { plan } = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(plan.policy.policyReasonCodes).toContain('SIMILAR_TO_ENTITY_PATH_AUTHORITY');
    expect(plan.plannerVersion).toBe('similar-to-entity-path-v1');
  });

  it('requires identity seal + anchor evidence in the admission contract', () => {
    const { plan, compiled } = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(plan.admission_context?.requires_identity_seal).toBe(true);
    expect(plan.admission_context?.requires_anchor_evidence).toBe(true);
    expect(compiled.execution.provenancePolicy.requireAnchorEvidence).toBe(true);
    expect(compiled.execution.provenancePolicy.requireIdentitySeal).toBe(true);
  });
});

describe('buildSimilarToEntityPrimitivePlan — structured residual constraints', () => {
  const priceCeiling: NormalizedConstraint = {
    attribute: 'price_usd',
    operator: '<=',
    value: 40,
    source_phrase: '50000원 이하',
    confidence: 1,
    soft_promotion_authority: 'allow',
    mapping_version: 'reference_similarity_tool_v1',
  };
  const regionFilter: NormalizedConstraint = {
    attribute: 'region',
    operator: '=',
    value: 'Bordeaux',
    source_phrase: 'Bordeaux',
    confidence: 1,
    soft_promotion_authority: 'allow',
    mapping_version: 'reference_similarity_tool_v1',
  };

  it('threads caller filters into hard constraints and preferences into soft', () => {
    const { plan } = buildSimilarToEntityPrimitivePlan(
      baseRequest({ filters: [regionFilter], preferences: [priceCeiling] }),
      'opus one',
    );
    expect(plan.constraints.hard).toContainEqual(regionFilter);
    expect(plan.constraints.soft).toContainEqual(priceCeiling);
  });

  it('flags constraint evidence required only when hard filters are present', () => {
    const without = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(without.plan.admission_context?.requires_constraint_evidence).toBe(false);
    const withFilter = buildSimilarToEntityPrimitivePlan(
      baseRequest({ filters: [regionFilter] }),
      'opus one',
    );
    expect(withFilter.plan.admission_context?.requires_constraint_evidence).toBe(true);
  });
});

describe('buildSimilarToEntityPrimitivePlan — guards & determinism', () => {
  it('throws when primitiveRoute is not similar_to_entity', () => {
    // No primitiveRoute → not a similar_to_entity request → the builder rejects it.
    const req: SearchRequest = { query: 'opus one' };
    expect(() => buildSimilarToEntityPrimitivePlan(req, 'opus one')).toThrow(/similar_to_entity/);
  });

  it('throws when the anchor entity is missing', () => {
    const req: SearchRequest = { query: 'opus one', primitiveRoute: 'similar_to_entity' };
    expect(() => buildSimilarToEntityPrimitivePlan(req, 'opus one')).toThrow(/anchorEntityId/);
  });

  it('is deterministic — identical input yields a structurally identical plan', () => {
    const a = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    const b = buildSimilarToEntityPrimitivePlan(baseRequest(), 'opus one');
    expect(a.plan).toEqual(b.plan);
    expect(a.compiled.execution).toEqual(b.compiled.execution);
  });
});
