import type { AgentPlannerDirective } from './agent-execution-state.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { extractPendingDrinkabilityEntityIds } from './agent-query-execution-contract.js';

/**
 * L1.C fast-answer bypass: structural conditions under which the planner's
 * second-round LLM call (the "emit answer" round) can be skipped because the
 * synthesis layer can produce a grounded answer directly from the first
 * tool observation. The predicate must mirror the planner-answer-acceptance
 * gates in `AgentToolExecutionPhase.run` so the bypass NEVER commits an answer
 * the planner would itself have rejected.
 */
export interface FastAnswerBypassInput {
  readonly queryExecutionContract: AgentQueryExecutionContract;
  readonly state: AgentExecutionState;
  readonly pendingDrinkabilityEntityIds: readonly string[];
}

export class AgentContractPolicy {
  buildGroundedSearchDirective(): AgentPlannerDirective {
    return {
      kind: 'grounded_search_required',
      instruction: 'This request still requires a grounded wine search before answering. Call search_wines first and answer only from the returned evidence.',
    };
  }

  buildRequiredToolDirective(tool: 'get_food_pairings'): AgentPlannerDirective {
    return {
      kind: 'required_tool',
      tool,
      instruction: `This request requires ${tool} before answering. Call ${tool} first and answer only from the returned evidence.`,
    };
  }

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

  buildPendingDrinkabilityDirective(entityIds: readonly string[]): AgentPlannerDirective {
    return { kind: 'pending_drinkability_check', entityIds };
  }

  buildDrinkabilityContractViolation(entityIds: readonly string[]): string {
    return `Tool contract violation: drinkability queries must call check_drinking_window next for ${entityIds.map((id) => `"${id}"`).join(', ')}.`;
  }

  /**
   * L1.C: structural fast-answer eligibility check. Returns true iff EVERY
   * contract gate that the planner would itself enforce on its
   * second-round `answer` emission is already satisfied. When true, the
   * caller MAY bypass the second planner LLM call and route directly to
   * observation synthesis. When false, the planner must run again (either
   * to refine the tool call or to emit a contract-aware answer).
   *
   * Semantics - bypass requires ALL of:
   *   - At least one tool outcome was produced (we have evidence to synthesize from)
   *   - `state.pendingRefinementRetry` is false (no relax-constraints retry pending)
   *   - `requiresGroundedWineSearch` is satisfied (or not requested)
   *   - `requiredTool`, if set, has produced an outcome
   *   - food-pairing -> search follow-up has been completed when applicable
   *   - no drinkability checks are still pending
   *   - no planner directive is queued (would otherwise re-enter the planner)
   *
   * This intentionally mirrors `AgentToolExecutionPhase.run`'s answer-accept
   * conditions one-to-one so the bypass cannot accept an answer the planner
   * would itself reject. Pure boolean predicate; no side effects.
   */
  canFastAnswerBypassPlanner(input: FastAnswerBypassInput): boolean {
    const { queryExecutionContract, state, pendingDrinkabilityEntityIds } = input;
    if (state.toolOutcomes.length === 0) return false;
    if (state.pendingRefinementRetry) return false;
    if (state.pendingPlannerDirective !== undefined) return false;
    if (queryExecutionContract.requiresGroundedWineSearch === true && state.toolOutcomes.length === 0) {
      return false;
    }
    if (
      queryExecutionContract.requiredTool !== undefined
      && !state.toolOutcomes.some((o) => o.tool === queryExecutionContract.requiredTool)
    ) {
      return false;
    }
    if (
      queryExecutionContract.requiredTool === 'get_food_pairings'
      && (
        queryExecutionContract.totalBudgetKrw !== undefined
        || queryExecutionContract.searchDefaults?.min_price_krw !== undefined
        || queryExecutionContract.searchDefaults?.max_price_krw !== undefined
      )
      && state.toolOutcomes.some((o) => o.tool === 'get_food_pairings')
      && !state.toolOutcomes.some((o) => o.tool === 'search_wines')
    ) {
      return false;
    }
    if (pendingDrinkabilityEntityIds.length > 0) return false;
    // All gates satisfied - the planner's second-round emit-answer would
    // accept; the synthesis layer can produce the grounded answer directly.
    return true;
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
    input: Record<string, unknown>,
  ): string | null {
    if (entityIds.length === 0) {
      return null;
    }
    if (tool !== 'check_drinking_window') {
      return this.buildDrinkabilityContractViolation(entityIds);
    }
    const requestedEntityId = input['entity_id'];
    return typeof requestedEntityId === 'string' && entityIds.includes(requestedEntityId)
      ? null
      : this.buildDrinkabilityContractViolation(entityIds);
  }
}
