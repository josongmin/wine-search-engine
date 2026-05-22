import type { AgentPlannerDirective } from './agent-execution-state.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type {
  AgentConstraintCoverageAtom,
  AgentQueryExecutionContract,
  AgentVerificationRequirement,
} from './agent-query-execution-contract.js';
import { extractPendingDrinkabilityEntityIds } from './agent-query-execution-contract.js';
import type { ToolOutcome } from '../../domain/agent/model/tool-outcome.js';

/**
 * L1.C fast-answer bypass: structural conditions under which the planner's
 * second-round LLM call (the "emit answer" round) can be skipped because the
 * synthesis layer can produce a grounded answer directly from the first
 * tool observation. The predicate must mirror the planner-answer-acceptance
 * gates in `AgentToolExecutionPhase.run` so the bypass NEVER commits an answer
 * the planner would itself have rejected.
 */
interface FastAnswerBypassInput {
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

  /**
   * P0: build a `verification_required` directive that pushes the planner into
   * a second verify/synthesize step. The instruction tells the planner to
   * either refine the tool call to satisfy the uncovered constraints, or to
   * emit an answer that explicitly cites grounding for every uncovered
   * constraint as "not satisfiable".
   *
   * @param requirement deterministic requirement built from the query contract
   * @param uncoveredConstraints constraints not yet covered by tool outcomes
   */
  buildVerificationRequiredDirective(
    requirement: AgentVerificationRequirement,
    uncoveredConstraints: readonly AgentConstraintCoverageAtom[],
  ): AgentPlannerDirective {
    const descriptors = uncoveredConstraints.length > 0
      ? uncoveredConstraints.map((atom) => atom.description)
      : requirement.constraintCoverage.map((atom) => atom.description);
    return {
      kind: 'verification_required',
      reason: requirement.reason,
      uncoveredConstraints: descriptors,
      instruction:
        'Emit either (a) a refined tool call narrowing on these constraints, '
        + 'or (b) an answer that explicitly cites grounding for every uncovered '
        + 'constraint — say "not satisfiable" for any constraint without evidence.',
    };
  }

  /**
   * P0: compute uncovered constraint atoms by intersecting required coverage
   * against grounded fields in the most recent tool outcome's GROUNDING_JSON.
   * A constraint atom is "covered" iff at least one returned wine has the
   * matching `matched_constraints[]` entry in the observation.
   *
   * Deterministic — no heuristics. If GROUNDING_JSON is absent or empty,
   * EVERY atom is treated as uncovered (forces re-plan).
   *
   * @param requirement deterministic requirement from contract
   * @param outcomes ordered tool outcomes (most recent last)
   */
  computeUncoveredConstraints(
    requirement: AgentVerificationRequirement,
    outcomes: readonly ToolOutcome[],
  ): readonly AgentConstraintCoverageAtom[] {
    if (requirement.constraintCoverage.length === 0) {
      return [];
    }
    const coveredKeys = collectCoveredMatchedConstraintKeys(outcomes);
    return requirement.constraintCoverage.filter(
      (atom) => !coveredKeys.has(atom.matchedConstraintKey),
    );
  }
}

/**
 * Extracts the union of GROUNDING_JSON.wines[].matched_constraints entries
 * from every tool outcome. Used by `computeUncoveredConstraints`.
 *
 * GROUNDING_JSON is emitted by the search use-case as part of the observation
 * string. We re-use ToolOutcome.result here when it carries a structured
 * shape, falling back to no-coverage when the result is opaque. Both string
 * and object forms of matched_constraints entries are accepted (LLM-facing
 * format is flexible).
 */
function collectCoveredMatchedConstraintKeys(
  outcomes: readonly ToolOutcome[],
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const outcome of outcomes) {
    const result = outcome.result;
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const record = result as Record<string, unknown>;
    const results = record['results'];
    if (Array.isArray(results)) {
      for (const item of results) {
        addMatchedConstraintKeys(covered, item);
      }
    }
    const entities = record['entities'];
    if (Array.isArray(entities)) {
      for (const entity of entities) {
        if (typeof entity === 'object' && entity !== null) {
          addMatchedConstraintKeys(covered, (entity as Record<string, unknown>)['topResult']);
          const allResults = (entity as Record<string, unknown>)['allResults'];
          if (Array.isArray(allResults)) {
            for (const item of allResults) {
              addMatchedConstraintKeys(covered, item);
            }
          }
        }
      }
    }
  }
  return covered;
}

function addMatchedConstraintKeys(target: Set<string>, item: unknown): void {
  if (typeof item !== 'object' || item === null) {
    return;
  }
  const record = item as Record<string, unknown>;
  const constraints = record['constraints'];
  if (typeof constraints !== 'object' || constraints === null) {
    return;
  }
  const matched = (constraints as Record<string, unknown>)['matched'];
  if (!Array.isArray(matched)) {
    return;
  }
  for (const entry of matched) {
    if (typeof entry === 'string') {
      target.add(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const attr = (entry as Record<string, unknown>)['attribute'];
      if (typeof attr === 'string') {
        target.add(attr);
      }
    }
  }
}
