import { describe, expect, it } from 'vitest';
import { decideAdmission } from '../service/admission-policy.js';

describe('decideAdmission', () => {
  it('rejects blocking exploratory recommendation flows when execution is degraded', () => {
    const outcome = decideAdmission({
      confidence: 0.9,
      evidenceSufficient: true,
      ambiguityHigh: false,
      routeHealthy: true,
      executionMode: 'degraded',
      effectiveRetrievalMode: 'recommendation',
      blockingRequested: true,
    });

    expect(outcome).toBe('reject');
  });

  it('rejects blocking exploratory comparison flows when execution is advisory', () => {
    const outcome = decideAdmission({
      confidence: 0.9,
      evidenceSufficient: true,
      ambiguityHigh: false,
      routeHealthy: true,
      executionMode: 'advisory',
      effectiveRetrievalMode: 'compare_candidates',
      blockingRequested: true,
    });

    expect(outcome).toBe('reject');
  });

  it('allows blocking exploratory flows when execution remains authoritative', () => {
    const outcome = decideAdmission({
      confidence: 0.9,
      evidenceSufficient: true,
      ambiguityHigh: false,
      routeHealthy: true,
      executionMode: 'authoritative',
      effectiveRetrievalMode: 'recommendation',
      blockingRequested: true,
    });

    expect(outcome).toBe('allow');
  });

  it('preserves legacy heuristic blocking rejection without retrieval mode', () => {
    const outcome = decideAdmission({
      confidence: 0.9,
      evidenceSufficient: true,
      ambiguityHigh: false,
      routeHealthy: true,
      executionMode: 'heuristic',
      blockingRequested: true,
    });

    expect(outcome).toBe('reject');
  });

  it('keeps degraded entity lookup backward compatible under blocking requests', () => {
    const outcome = decideAdmission({
      confidence: 0.9,
      evidenceSufficient: true,
      ambiguityHigh: false,
      routeHealthy: true,
      executionMode: 'degraded',
      effectiveRetrievalMode: 'entity_lookup',
      blockingRequested: true,
    });

    expect(outcome).toBe('allow');
  });
});
