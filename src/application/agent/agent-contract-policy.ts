import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { extractPendingDrinkabilityEntityIds } from './agent-query-execution-contract.js';

export class AgentContractPolicy {
  getPendingDrinkabilityEntityIds(
    queryExecutionContract: AgentQueryExecutionContract,
    state: AgentExecutionState,
  ): readonly string[] {
    return extractPendingDrinkabilityEntityIds(
      queryExecutionContract,
      state.steps,
      state.toolOutcomes,
    );
  }

  buildPendingDrinkabilityAnswerHint(entityIds: readonly string[]): string {
    return `HINT: This query asks about drinkability. Before answering, you MUST call check_drinking_window for ${entityIds.map((id) => `"${id}"`).join(', ')} using the literal entity_id from the latest search/comparison result.`;
  }

  buildDrinkabilityContractViolation(entityIds: readonly string[]): string {
    return `Tool contract violation: drinkability queries must call check_drinking_window next for ${entityIds.map((id) => `"${id}"`).join(', ')}.`;
  }

  validateDrinkabilityBatch(
    entityIds: readonly string[],
    calls: readonly {
      readonly tool: string;
      readonly input: Record<string, unknown>;
    }[],
  ): string | null {
    if (entityIds.length === 0) {
      return null;
    }

    const requestedIds = new Set(
      calls
        .filter((call) => call.tool === 'check_drinking_window')
        .map((call) => call.input['entity_id'])
        .filter((entityId): entityId is string => typeof entityId === 'string' && entityId.trim().length > 0),
    );
    const missingIds = entityIds.filter((entityId) => !requestedIds.has(entityId));
    const hasOnlyDrinkabilityChecks = calls.every((call) => call.tool === 'check_drinking_window');
    return !hasOnlyDrinkabilityChecks || missingIds.length > 0
      ? this.buildDrinkabilityContractViolation(entityIds)
      : null;
  }

  validateDrinkabilitySingleStep(
    entityIds: readonly string[],
    tool: string,
  ): string | null {
    return entityIds.length > 0 && tool !== 'check_drinking_window'
      ? this.buildDrinkabilityContractViolation(entityIds)
      : null;
  }
}
