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

  it('auto noisy hybrid recovery resolves on dual-lane with aligned lane projection', async () => {
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
      route: 'hybrid',
      topology: 'dual_lane',
    });
    expect(response.engineDecision.laneTrace?.identity.participated).toBe(true);
    expect(response.engineDecision.laneTrace?.identity.resolveStatus).toBe('ambiguous');
    expect(response.engineDecision.laneTrace?.general.participated).toBe(true);
    expect(response.engineDecision.laneTrace?.general.artifactCount).toBeGreaterThan(0);
    expect(response.engineDecision.laneTrace?.fused.resolveStatus).toBe('resolved');
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBe('decision_gate_resolved');
  });

  it('auto noisy approximate query stays ambiguous on dual-lane when identity evidence is absent', async () => {
    const response = await parts.container.searchUseCase.execute(
      {
        query: 'opuss one',
        options: { mode: 'auto', explain: true, clarification: false },
      },
      'noisy-runtime-dual-lane-ambiguous',
    );

    expect(response.results[0]?.entity.entityId).toBe('opus-one-2018');
    expect(response.engineDecision.decisionStatus).toBe('ambiguous');
    expectExecutionContractProjection(response, {
      route: 'hybrid',
      topology: 'dual_lane',
    });
    expect(response.engineDecision.laneTrace?.identity.participated).toBe(true);
    expect(response.engineDecision.laneTrace?.identity.resolveStatus).toBe('failed');
    expect(response.engineDecision.laneTrace?.general.participated).toBe(true);
    expect(response.engineDecision.laneTrace?.general.artifactCount).toBeGreaterThan(0);
    expect(response.engineDecision.laneTrace?.fused.resolveStatus).toBe('resolved');
    expect(response.meta.provenanceTrace?.gateDecisions.decision).toBe('decision_gate_ambiguous');
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
