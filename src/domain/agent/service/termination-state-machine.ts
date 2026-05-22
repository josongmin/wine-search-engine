/**
 * Termination reason state machine.
 *
 * Many independent code paths (planner-phase result policy, tool-execution result
 * policy, contract-execution result policy, run-loop termination policy,
 * observation-synthesis runner, answer-recovery policy, tool-execution-phase)
 * write `state.terminationReason`. Without a central transition rule,
 * last-writer-wins, and a benign `'answer'` could overwrite a hard failure like
 * `'aborted'` or `'blocked'`, or a recovery layer could DOWNGRADE a
 * higher-priority terminal signal. (Property P9: recovery may only upgrade or
 * preserve priority, never downgrade.)
 *
 * This module defines a single priority order and a pure transition function.
 * Callers replace bare assignments
 *   state.terminationReason = X
 * with
 *   state.terminationReason = transitionTerminationReason(state.terminationReason, X)
 *
 * Higher priority dominates. Equal priority allows the later write to win
 * (preserves the existing "last-writer-among-peers" behavior for same-class
 * transitions such as 'error' -> 'error').
 *
 * A3 outcome semantics: completions (`answer`/`fallback`) rank ABOVE the
 * resource-limit reasons (`budget`/`timeout`/`max_steps`). A ReAct run that
 * produced a final grounded answer is a terminal SUCCESS even if a resource
 * limit was hit along the way -- the answer came through. Resource limits are
 * only the dominant signal when NO completion was produced. Hard failures
 * (`aborted`/`blocked`/`error`/`loop_detected`) still dominate completions: a
 * cancelled/blocked/errored run that coincidentally set `'answer'` must report
 * the failure. See the 3-class rationale on TERMINATION_PRIORITY below.
 */
import type { AgentTerminationReason } from '../model/agent-step.js';

/**
 * Priority table.
 *
 * The nine reasons fall into THREE semantic classes:
 *
 * -- Class 1: HARD FAILURES (highest) -- `aborted > blocked > error > loop_detected`
 *   The run was structurally terminated. A cancelled / policy-blocked / errored
 *   / loop-stopped run is NOT a success even if a later layer coincidentally set
 *   `'answer'`/`'fallback'`. These MUST dominate everything, including
 *   completions, so the failure is never papered over.
 *
 * -- Class 2: COMPLETIONS (middle) -- `answer > fallback`
 *   The run produced output for the user. In ReAct semantics a run that produced
 *   a final grounded answer is a terminal SUCCESS -- it must pre-empt
 *   resource-limit reasons (the limits may have been hit, but the answer came
 *   through anyway). `fallback` ranks BELOW `answer` so a real grounded answer
 *   wins over a substitute, but ABOVE resource limits because the user still
 *   received a usable response.
 *
 * -- Class 3: RESOURCE LIMITS (lowest above the sentinel) -- `budget > timeout`
 *   The run stopped because it ran out of budget WITHOUT producing a clean
 *   completion. Only the dominant signal when NO completion was produced.
 *
 * -- Sentinel (lowest) -- `max_steps`
 *   `AgentExecutionState.terminationReason` is initialized to `'max_steps'`.
 *   Lowest priority so ANY explicit transition replaces it.
 *
 * The numeric values are arbitrary as long as they encode the order above; they
 * are referenced only by `priorityOf` (CLAUDE.md rule 15: no magic numbers in
 * priority logic). Each class occupies a disjoint band (gaps of 10) so future
 * reasons can be slotted within a class without renumbering across classes.
 */
// -- Class 1: hard failures ------------------------------------------------
const PRIORITY_ABORTED = 90;
const PRIORITY_BLOCKED = 80;
const PRIORITY_ERROR = 70;
const PRIORITY_LOOP_DETECTED = 60;
// -- Class 2: completions (A3: rank ABOVE resource limits) -----------------
const PRIORITY_ANSWER = 50;
const PRIORITY_FALLBACK = 40;
// -- Class 3: resource limits ----------------------------------------------
const PRIORITY_BUDGET = 30;
const PRIORITY_TIMEOUT = 20;
// -- Sentinel --------------------------------------------------------------
const PRIORITY_MAX_STEPS = 10;

const TERMINATION_PRIORITY: Readonly<Record<AgentTerminationReason, number>> = {
  aborted: PRIORITY_ABORTED,
  blocked: PRIORITY_BLOCKED,
  error: PRIORITY_ERROR,
  loop_detected: PRIORITY_LOOP_DETECTED,
  answer: PRIORITY_ANSWER,
  fallback: PRIORITY_FALLBACK,
  budget: PRIORITY_BUDGET,
  timeout: PRIORITY_TIMEOUT,
  max_steps: PRIORITY_MAX_STEPS,
};

function priorityOf(reason: AgentTerminationReason): number {
  return TERMINATION_PRIORITY[reason];
}

/**
 * Returns `next` iff its priority is greater than or equal to `current`'s.
 * Equal priority lets the new write win -- this preserves the legacy
 * last-writer behavior between peers of the same class without ever letting a
 * softer outcome overwrite a harder one.
 *
 * `current === undefined` (no terminationReason yet recorded) always yields
 * `next`.
 */
export function transitionTerminationReason(
  current: AgentTerminationReason | undefined,
  next: AgentTerminationReason,
): AgentTerminationReason {
  if (current === undefined) {
    return next;
  }
  return priorityOf(next) >= priorityOf(current) ? next : current;
}

/** Exposed for diagnostic logging / regression tests. Do not mutate. */
export const TERMINATION_REASON_PRIORITY: Readonly<Record<AgentTerminationReason, number>> =
  TERMINATION_PRIORITY;
