import { describe, it, expect } from 'vitest';
import { determineRoute, determineRetrievalMode } from '../planner-routing.js';
import type { AnchorCandidate } from '../../model/anchor-candidate.js';
import { createCanonicalEntityId } from '../../../shared/types/entity-id.js';

/**
 * RFC-021 T-PSA-03 — owner-local proof rail for the public primitive discovery
 * lane authority. When `lockDiscoveryLane` is set (only the
 * `/v1/search/{hybrid,semantic,lexical}` routes set it), the planner's routing
 * heuristics must NOT promote the request onto the entity or mixed/anchor-
 * similarity lanes — the path-selected lane stays authoritative.
 */

function anchor(confidence: number): AnchorCandidate {
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: [createCanonicalEntityId('opus-one-2018')],
    confidence,
    source: 'alias',
  };
}

describe('determineRoute — lane lock', () => {
  it('forces hybrid for a mixed_query with a strong anchor (would otherwise be "mixed")', () => {
    expect(determineRoute('mixed_query', [anchor(0.9)])).toBe('mixed'); // baseline
    expect(determineRoute('mixed_query', [anchor(0.9)], true)).toBe('hybrid');
  });

  it('forces hybrid for an exact entity intent (would otherwise be "entity")', () => {
    expect(determineRoute('entity_exact', [anchor(0.95)])).toBe('entity'); // baseline
    expect(determineRoute('entity_exact', [anchor(0.95)], true)).toBe('hybrid');
  });

  it('forces hybrid for comparison intent (would otherwise be "entity")', () => {
    expect(determineRoute('comparison_search', [anchor(0.9)], true)).toBe('hybrid');
  });

  it('leaves an already-hybrid discovery intent unchanged', () => {
    expect(determineRoute('semantic_discovery', [], true)).toBe('hybrid');
    expect(determineRoute('facet_search', [], true)).toBe('hybrid');
  });
});

describe('determineRetrievalMode — lane lock', () => {
  it('coerces similar_items (mixed + anchor) to attribute_search', () => {
    expect(determineRetrievalMode('mixed_query', [anchor(0.9)], 'opus one 비슷한')).toBe('similar_items'); // baseline
    expect(determineRetrievalMode('mixed_query', [anchor(0.9)], 'opus one 비슷한', true)).toBe('attribute_search');
  });

  it('coerces entity_lookup (exact + strong anchor) to attribute_search', () => {
    expect(determineRetrievalMode('entity_exact', [anchor(0.95)], 'opus one')).toBe('entity_lookup'); // baseline
    expect(determineRetrievalMode('entity_exact', [anchor(0.95)], 'opus one', true)).toBe('attribute_search');
  });

  it('coerces compare_candidates to attribute_search', () => {
    expect(determineRetrievalMode('comparison_search', [anchor(0.9)], 'a vs b', true)).toBe('attribute_search');
  });

  it('preserves the recommendation discovery sub-mode (runs on the hybrid pool, lane filter still applies)', () => {
    expect(determineRetrievalMode('pairing_search', [], '스테이크 와인', true)).toBe('recommendation');
  });

  // All of these are hybrid-route sub-modes: they keep flowing through the
  // candidate pool, so the path-selected lane filter still applies. The lock
  // must NOT coerce them (audit N4 hardening).
  it('preserves constraint_filter (facet/budget, no anchor)', () => {
    expect(determineRetrievalMode('facet_search', [], 'dry red under 50000', true)).toBe('constraint_filter');
    expect(determineRetrievalMode('budget_search', [], '5만원 이하', true)).toBe('constraint_filter');
  });

  it('preserves region_browse (facet + region hierarchy path)', () => {
    const slashPath = 'France / Bordeaux / Margaux';
    expect(determineRetrievalMode('facet_search', [], slashPath)).toBe('region_browse'); // baseline
    expect(determineRetrievalMode('facet_search', [], slashPath, true)).toBe('region_browse');
  });

  it('preserves a plain discovery mode unchanged', () => {
    const baseline = determineRetrievalMode('semantic_discovery', [], '풀바디 레드');
    expect(determineRetrievalMode('semantic_discovery', [], '풀바디 레드', true)).toBe(baseline);
  });
});
