import type { FastifyInstance } from 'fastify';
import type { DecisionSnapshot } from '../../../src/domain/shared/types/index.js';
import {
  buildDecisionSnapshotId,
  SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../src/application/search/search-usecase-decision-snapshot.js';
import { parseSearchResponse, postJson } from './http-transport.js';

export function makeReplaySnapshot(
  overrides: Partial<Omit<DecisionSnapshot, 'snapshot_id'>> = {},
): DecisionSnapshot {
  const snapshotBase = {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: SEARCH_RESPONSE_CONTRACT_VERSION,
    ...overrides,
  };

  return {
    ...snapshotBase,
    snapshot_id: buildDecisionSnapshotId(snapshotBase),
  };
}

export async function fetchReplaySnapshot(
  app: FastifyInstance,
  request: {
    readonly query: string;
    readonly context?: Record<string, unknown>;
    readonly sessionContext?: Record<string, unknown>;
    readonly queryBudget?: Record<string, unknown>;
    readonly options?: Record<string, unknown>;
  },
): Promise<DecisionSnapshot> {
  const response = await postJson(app, '/v1/search', request);
  if (response.statusCode !== 200) {
    throw new Error(
      `expected live search to return 200 before replay, got ${response.statusCode}: ${response.body}`,
    );
  }
  return parseSearchResponse(response).engine_decision.decision_snapshot;
}
