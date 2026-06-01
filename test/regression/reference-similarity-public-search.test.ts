/**
 * RFC-021 T-PSA-04 — fail-closed regression rail for the PUBLIC primitive
 * search lane authority + reference-similarity observability.
 *
 * Locks two invariants:
 *
 *   1. PUBLIC LANE AUTHORITY — the public discovery routes
 *      (`/v1/search/{hybrid,semantic,lexical}`) carry a path-selected retrieval
 *      lane. A similarity heuristic (e.g. a Korean "비슷한"/"같은" marker) must
 *      NEVER be allowed to override that lane onto the mixed/anchor-similarity
 *      route. Public search is non-agentic — composition is the agent's job,
 *      not the public route's. We prove the same anchored-similarity surface
 *      form routes to `mixed` WITHOUT the lane lock and to `hybrid` WITH it.
 *   2. OBSERVABILITY IS NOT CONFLATED — a `similar_items` plan reports the
 *      `reference_similarity` query family, not the generic `recommendation`
 *      bucket it used to be folded into (which hid anchor-similarity behavior).
 *
 * Append-only (CLAUDE.md): never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import {
  determineRoute,
  determineRetrievalMode,
} from '../../src/domain/query/service/planner-routing.js';
import { buildPlannerContextFromSearchRequest } from '../../src/application/search/search-usecase-planner-context.js';
import { buildSimilarToEntityPrimitivePlan } from '../../src/application/search/search-usecase-caller-controlled-plan.js';
import { buildReferenceSimilarityAuditTrace } from '../../src/application/search/post-route-phase-audit-extension.js';
import { deriveQueryFamily } from '../../src/domain/query/model/query-observability-vocab.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { AnchorCandidate } from '../../src/domain/query/model/anchor-candidate.js';
import type { SearchRequest } from '../../src/application/search/search-request.dto.js';

const ANCHOR: AnchorCandidate = {
  surfaceForm: '오푸스원',
  normalizedForm: '오푸스원',
  candidateEntityIds: [createCanonicalEntityId('opus-one-2018')],
  confidence: 0.9,
  source: 'alias',
};

describe('public-search rail — path lane authority overrides the similarity heuristic', () => {
  it('baseline: an anchored mixed_query routes to the mixed/similar_items lane (no lock)', () => {
    expect(determineRoute('mixed_query', [ANCHOR])).toBe('mixed');
    expect(determineRetrievalMode('mixed_query', [ANCHOR], '오푸스원 같은 와인')).toBe('similar_items');
  });

  it('locked: the SAME anchored similarity query stays on the path-selected hybrid lane', () => {
    expect(determineRoute('mixed_query', [ANCHOR], true)).toBe('hybrid');
    expect(determineRetrievalMode('mixed_query', [ANCHOR], '오푸스원 같은 와인', true)).not.toBe(
      'similar_items',
    );
  });

  it('locked: an exact-entity surface form also stays on the discovery lane (no entity-route hijack)', () => {
    expect(determineRoute('entity_exact', [ANCHOR], true)).toBe('hybrid');
    expect(determineRetrievalMode('entity_exact', [ANCHOR], '오푸스원', true)).not.toBe('entity_lookup');
  });

  it('the lane lock is engaged exactly when the request carries a path-selected retrievalLane', () => {
    const locked: SearchRequest = { query: '오푸스원 같은 와인', retrievalLane: 'hybrid' };
    const unlocked: SearchRequest = { query: '오푸스원 같은 와인' };
    expect(buildPlannerContextFromSearchRequest(locked).lockDiscoveryLane).toBe(true);
    expect(buildPlannerContextFromSearchRequest(unlocked).lockDiscoveryLane).toBeUndefined();
  });
});

describe('public-search rail — reference-similarity observability is not conflated', () => {
  it('a similar_items plan reports the reference_similarity family (not recommendation)', () => {
    const { plan, compiled } = buildSimilarToEntityPrimitivePlan(
      {
        query: 'opus-one-2018',
        primitiveRoute: 'similar_to_entity',
        anchorEntityId: createCanonicalEntityId('opus-one-2018'),
      },
      'opus-one-2018',
    );
    expect(deriveQueryFamily(plan, compiled)).toBe('reference_similarity');
    expect(deriveQueryFamily(plan, compiled)).not.toBe('recommendation');
  });

  it('a lane-locked anchored similarity query stays reference_similarity instead of regressing to comparison', () => {
    const plan = {
      rawQuery: '오푸스원 같은 와인',
      normalizedQuery: '오푸스원 같은 와인',
      intent: 'mixed_query',
      route: 'mixed',
      retrievalMode: 'similar_items',
      queryClass: 'anchored_similarity',
      anchors: [ANCHOR],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'hybrid',
        policyReasonCodes: [],
      },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.8,
        anchorConfidence: 0.9,
        constraintConfidence: 0.1,
      },
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
    } as const;
    const compiled = {
      query: {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        intent: plan.intent,
        queryClass: plan.queryClass,
        anchors: plan.anchors,
        constraints: plan.constraints,
        expansions: plan.expansions,
        uncertainty: plan.uncertainty,
        plannerVersion: plan.plannerVersion,
        policyRuleVersion: plan.policyRuleVersion,
        thresholdProfileId: plan.thresholdProfileId,
      },
      execution: {
        effectiveRoute: 'hybrid',
        effectiveRetrievalMode: 'attribute_search',
        routeSource: 'planner',
        budget: { maxCandidates: 50, enablePrecisionRerank: true },
        provenancePolicy: {
          requireIdentitySeal: false,
          requireConstraintEvidence: false,
          requireAnchorEvidence: false,
        },
      },
    } as const;

    expect(deriveQueryFamily(plan, compiled)).toBe('reference_similarity');
    expect(deriveQueryFamily(plan, compiled)).not.toBe('comparison');
  });
});

describe('public-search rail — reference-similarity trace provenance (T-PSA-04 DoD#2)', () => {
  const { compiled } = buildSimilarToEntityPrimitivePlan(
    {
      query: 'opus-one-2018',
      primitiveRoute: 'similar_to_entity',
      anchorEntityId: createCanonicalEntityId('opus-one-2018'),
    },
    'opus-one-2018',
  );

  it('surfaces source anchor id, similarity profile, and same-entity exclusion as machine-checkable fields', () => {
    const trace = buildReferenceSimilarityAuditTrace(compiled, 'similar_items');
    expect(trace).toBeDefined();
    expect(trace?.source_anchor_entity_id).toBe('opus-one-2018');
    expect(trace?.retrieval_mode).toBe('similar_items');
    // Profile id is resolved from the SSoT family policy, never hardcoded.
    expect(trace?.similarity_profile_id).toBe('mixed_anchor');
    expect(trace?.same_entity_exclusion).toBe('anchor_seed_excluded');
  });

  it('omits the trace on every non-similarity retrieval mode', () => {
    expect(buildReferenceSimilarityAuditTrace(compiled, 'attribute_search')).toBeUndefined();
    expect(buildReferenceSimilarityAuditTrace(compiled, 'entity_lookup')).toBeUndefined();
  });
});
