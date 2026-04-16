import type { AgentStep } from '../../domain/agent/model/agent-step.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { ToolOutcome } from './tool-outcome.js';

const GROUNDING_OUTCOME_KINDS = new Set<ToolOutcome['kind']>([
  'success',
  'partial_result',
  'empty_result',
]);
const STEP_ID_STEP_INDEX_OFFSET_FROM_END = 2;

function parseStepIndex(stepId: string): number | undefined {
  const parts = stepId.split(':');
  const stepIndexText = parts.at(-STEP_ID_STEP_INDEX_OFFSET_FROM_END);
  if (stepIndexText === undefined) {
    return undefined;
  }
  const stepIndex = Number(stepIndexText);
  if (!Number.isFinite(stepIndex)) {
    return undefined;
  }
  return Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : undefined;
}

function hasLegacyObservation(step: AgentStep): boolean {
  return (
    (step.observation !== undefined && step.observation.length > 0) ||
    (step.actionPairs !== undefined && step.actionPairs.some((pair) => pair.observation.length > 0))
  );
}

function isGroundingToolOutcome(outcome: ToolOutcome): boolean {
  return GROUNDING_OUTCOME_KINDS.has(outcome.kind);
}

export function getGroundingObservationSteps(state: AgentExecutionState): readonly AgentStep[] {
  if (state.toolOutcomes.length === 0) {
    return state.steps.filter(hasLegacyObservation);
  }

  const groundingStepIndexes = new Set<number>();
  for (const outcome of state.toolOutcomes) {
    if (!isGroundingToolOutcome(outcome)) {
      continue;
    }
    const stepIndex = parseStepIndex(outcome.stepId);
    if (stepIndex !== undefined) {
      groundingStepIndexes.add(stepIndex);
    }
  }

  return state.steps.filter((step) => groundingStepIndexes.has(step.index) && hasLegacyObservation(step));
}

export function hasGroundingToolObservations(state: AgentExecutionState): boolean {
  return getGroundingObservationSteps(state).length > 0;
}

export function getLastGroundingObservationText(state: AgentExecutionState): string | undefined {
  const lastStep = getGroundingObservationSteps(state).at(-1);
  return (
    lastStep?.observation ??
    lastStep?.actionPairs?.find((pair) => pair.observation.length > 0)?.observation
  );
}
