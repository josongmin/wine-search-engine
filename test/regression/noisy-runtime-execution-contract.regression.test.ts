import { describe, expect, it } from 'vitest';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import type { ExecutionTopology } from '../../src/domain/query/model/engine-execution-contract.js';
import { createTestContainer } from '../integration/helpers/test-container.js';

function expectExecutionContractProjection(
  response: SearchResponseV1,
  expected: {
    readonly route: 'entity' | 'hybrid';
    readonly topology: ExecutionTopology;
  },
): void {
  expect(response.engineDecision.route).toBe(expected.route);
  expect(response.engineDecision.executionTopology).toBe(expected.topology);
  expect(response.meta.executionContract?.executionTopology).toBe(expected.topology);
  expect(response.meta.executionContract?.usedCompiledExecution).toBe(true);
  expect(response.meta.executionContract?.laneTrace).toEqual(response.engineDecision.laneTrace);
  expect(response.meta.auditExtension?.execution_trace).toMatchObject({
    effective_route: expected.route,
    execution_topology: expected.topology,
    used_compiled_execution: true,
  });
  expect(response.meta.auditExtension?.execution_trace?.lane_trace).toEqual(
    response.engineDecision.laneTrace,
  );
}

describe('Noisy runtime execution contract', () => {
  const parts = createTestContainer();

  it.each([
    ['샤또 마고', 'chateau-margaux-2015'],
    ['오푸스원', 'opus-one-2018'],
  ] as const)(
    'auto exact noisy query %s keeps entity-only identity contract',
    async (query, expectedEntityId) => {
      const response = await parts.container.searchUseCase.execute(
        {
          query,
          options: { mode: 'auto', explain: true, clarification: false },
        },
        `noisy-runtime-entity-${expectedEntityId}`,
      );

      expect(response.engineDecision.decisionStatus).toBe('resolved');
      expect(response.results[0]?.entity.entityId).toBe(expectedEntityId);
      expectExecutionContractProjection(response, {
        route: 'entity',
        topology: 'entity_only',
      });
      expect(response.engineDecision.laneTrace).toMatchObject({
        identity: { participated: true, resolveStatus: 'resolved' },
        general: { participated: false, artifactCount: 0 },
        fused: { participated: false, artifactCount: 0 },
      });
    },
  );

  it('auto noisy vintage-bearing typo resolves on the entity route via fuzzy identity recovery', async () => {
    const response = await parts.container.searchUseCase.execute(
      {
        query: 'Chateau Margxaux 2015',
        options: { mode: 'auto', explain: true, clarification: false },
      },
      'noisy-runtime-dual-lane-resolved',
    );

    expect(response.engineDecision.decisionStatus).toBe('resolved');
    expect(response.results[0]?.entity.entityId).toBe('chateau-margaux-2015');
    expectExecutionContractProjection(response, {
      route: 'entity',
      topology: 'entity_only',
    });
    expect(response.engineDecision.laneTrace).toMatchObject({
      identity: { participated: true, resolveStatus: 'resolved' },
      general: { participated: false, artifactCount: 0 },
      fused: { participated: false, artifactCount: 0 },
    });
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBeUndefined();
  });

  it('auto single-typo Latin query resolves on the entity route via fuzzy identity recovery', async () => {
    // SOTA KIL behaviour (Damerau fuzzy alias matcher, calibrated decision):
    // a single clearly-resolvable typo of a known wine ("opuss one" → "opus one",
    // edit distance 1, no competing entity within the similarity threshold) is
    // recovered by the fuzzy identity lane, routed as a known-item lookup, and
    // resolved. The previous contract assumed *no* fuzzy identity evidence
    // ("…stays ambiguous on dual-lane when identity evidence is absent") —
    // valid only while the in-memory matcher lacked a fuzzy stage; production's
    // pg-alias-matcher has had a Damerau channel all along. With the in-memory
    // matcher now at production parity, the premise no longer holds.
    //
    // The hallucination guard is still pinned by the *bare* short-form test
    // immediately below ("opus" → ambiguous): a query that doesn't uniquely
    // identify any single entity (bare producer name, generic term) MUST NOT
    // confidently resolve. That's the case where the guard protects the user;
    // a single edit-distance-1 typo with one clear target is not.
    const response = await parts.container.searchUseCase.execute(
      {
        query: 'opuss one',
        options: { mode: 'auto', explain: true, clarification: false },
      },
      'noisy-runtime-single-typo-resolves',
    );

    expect(response.results[0]?.entity.entityId).toBe('opus-one-2018');
    expect(response.engineDecision.decisionStatus).toBe('resolved');
    expectExecutionContractProjection(response, {
      route: 'entity',
      topology: 'entity_only',
    });
    expect(response.engineDecision.laneTrace?.identity.participated).toBe(true);
    expect(response.engineDecision.laneTrace?.identity.resolveStatus).toBe('resolved');
    expect(response.engineDecision.laneTrace?.identity.artifactCount).toBeGreaterThan(0);
    // Identity resolved confidently → the general lane is correctly skipped
    // (entity-only topology). This is the SOTA routing behaviour for a
    // confident known-item match.
    expect(response.engineDecision.laneTrace?.general.participated).toBe(false);
    // The audit suggested re-pinning `gateDecisions.decision`, but it is
    // empirically `undefined` on the `entity_only` topology — the gate
    // trace is populated by the fused-lane decision path, which doesn't
    // run here. Asserting any specific value would be wrong. The decision
    // contract is already pinned by `decisionStatus='resolved'` above.
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBeUndefined();
  });

  it('auto Latin typo with multiple in-fixture candidates stays ambiguous (multi-candidate fuzzy guard)', async () => {
    // Companion guard for the SOTA single-typo resolve case above:
    // when a Latin typo could plausibly map to *more than one* in-fixture
    // alias within the fuzzy similarity threshold, the calibrated gap
    // narrows and the decision engine MUST stay ambiguous instead of
    // confidently sealing identity (Epic 17.3 hallucination guard, encoded
    // by `NOISY_SHORT_QUERY_GUARD` in decision-engine.ts).
    //
    // The default fixture ships both `Penfolds Grange` and `Penfolds Bin 389`-
    // adjacent aliases via the regular grange entity plus a Korean catalog
    // counterpart; "penfols" (single deletion of the 'd') is within
    // Damerau-1 of "penfolds" and Damerau-2 of multiple Penfolds-namespaced
    // surfaces. With multiple candidates inside the fuzzy band the system
    // must abstain, not seal.
    const response = await parts.container.searchUseCase.execute(
      {
        query: 'penfols',
        options: { mode: 'auto', explain: true, clarification: false },
      },
      'noisy-runtime-multi-candidate-fuzzy-guard',
    );

    // Whether the top entity is grange or another Penfolds-namespaced row
    // is not the assertion — abstention is. Recall-K elsewhere covers the
    // "did the user's intended entity surface" question.
    expect(response.engineDecision.decisionStatus).not.toBe('resolved');
  });

  it('hybrid override on short Korean prefix query preserves identity evidence and resolves', async () => {
    const response = await parts.container.searchUseCase.execute(
      {
        query: '오푸',
        options: { mode: 'hybrid', explain: true, clarification: false },
      },
      'noisy-runtime-general-only-downgrade',
    );

    expect(response.results[0]?.entity.entityId).toBe('opus-one-2018');
    expect(response.engineDecision.decisionStatus).toBe('resolved');
    expectExecutionContractProjection(response, {
      route: 'hybrid',
      topology: 'general_only',
    });
    expect(response.engineDecision.laneTrace).toMatchObject({
      identity: { participated: true, resolveStatus: 'resolved' },
      general: { participated: true },
      fused: { participated: true, resolveStatus: 'resolved' },
    });
    expect(response.engineDecision.laneTrace?.identity.artifactCount).toBeGreaterThan(0);
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBe('decision_gate_resolved');
  });

  it('hybrid override on bare noisy short form withholds identity seal and stays ambiguous', async () => {
    const response = await parts.container.searchUseCase.execute(
      {
        query: 'opus',
        options: { mode: 'hybrid', explain: true, clarification: false },
      },
      'noisy-runtime-general-only-bare-short-form',
    );

    expect(response.results[0]?.entity.entityId).toBe('opus-one-2018');
    expect(response.engineDecision.decisionStatus).toBe('ambiguous');
    expectExecutionContractProjection(response, {
      route: 'hybrid',
      topology: 'general_only',
    });
    expect(response.engineDecision.laneTrace).toMatchObject({
      identity: { participated: true },
      general: { participated: true },
      fused: { participated: true },
    });
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBe('decision_gate_ambiguous');
  });
});
