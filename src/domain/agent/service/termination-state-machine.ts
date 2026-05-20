/**
 * Termination reason state machine.
 *
 * Many independent code paths (planner-phase result policy, tool-execution result
 * policy, contract-execution result policy, run-loop termination policy,
 * observation-synthesis runner, answer-recovery policy, tool-execution-phase)
 * write `state.terminationReason`. Without a central transition rule,
 * last-writer-wins, and a benign `'answer'` could overwrite a hard failure like
 * `'aborted'` or `'blocked'`, or vice versa, depending on layer ordering.
 *
 * This module defines a single priority order and a pure transition function.
 * Callers replace bare assignments
 *   state.terminationReason = X
 * with
 *   state.terminationReason = transitionTerminationReason(state.terminationReason, X)
 *
 * Higher priority dominates. Equal priority allows the later write to win
 * (preserves the existing "last-writer-among-peers" behavior for same-class
 * transitions such as 'error' → 'error').
 */
import type { AgentTerminationReason } from '../model/agent-step.js';

/**
 * Priority table.
 *
 * Rationale:
 * - `aborted` is an explicit user/host cancellation; it must never be
 *   overwritten by softer outcomes including `'answer'` or `'max_steps'`.
 * - `blocked` is a policy/security decision; downstream synthesis must not
 *   silently re-route a blocked query into a benign answer.
 * - `error` is an unrecoverable internal failure; it dominates over fallback
 *   and answer to preserve diagnostic signal.
 * - `loop_detected` is a structural safety stop; it must not be papered over
 *   by a later max_steps or fallback transition.
 * - `budget` exhaustion (token/step) is an enforced limit; ranked above
 *   `timeout` because budget exhaustion is observable from inside the loop
 *   while timeout is wall-clock externality.
 * - `timeout` is a soft loop termination dominated by all hard failures.
 * - `fallback` indicates the synthesis stage produced a substitute answer;
 *   it ranks above `answer` so that "we used a fallback" provenance is
 *   preserved if a later answer-recovery layer also writes 'answer'.
 * - `answer` is the happy path; it must overwrite the default `'max_steps'`
 *   sentinel that the state begins with.
 * - `max_steps` is the sentinel/default — it is the lowest priority so that
 *   ANY explicit transition replaces it. Treat it as "no real terminator
 *   recorded yet" rather than as a substantive outcome.
 *
 * The numeric values are arbitrary as long as they encode the order above.
 * They are referenced only by `priorityOf` below — never compared inline by
 * callers (CLAUDE.md rule 15: no magic numbers in penalty/priority logic).
 */
const TERMINATION_PRIORITY: Readonly<Record<AgentTerminationReason, number>> = {
  aborted: 90,
  blocked: 80,
  error: 70,
  loop_detected: 60,
  budget: 50,
  timeout: 40,
  fallback: 30,
  answer: 20,
  max_steps: 10,
};

function priorityOf(reason: AgentTerminationReason): number {
  return TERMINATION_PRIORITY[reason];
}

/**
 * Returns `next` iff its priority is greater than or equal to `current`'s.
 * Equal priority lets the new write win — this preserves the legacy
 * last-writer behavior between peers of the same class (e.g. error → error,
 * aborted → aborted) without ever letting a softer outcome overwrite a
 * harder one.
 *
 * `current === undefined` (no terminationReason yet recorded) always yields
 * `next`. Today `AgentExecutionState.terminationReason` is initialized to
 * `'max_steps'`, but supporting the undefined sentinel keeps this function
 * usable from any future call site that hasn't seeded a default yet.
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
