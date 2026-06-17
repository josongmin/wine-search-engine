import {
  buildInterpretQueryRunner,
  type InterpretQueryRunner,
  type InterpretQueryRunnerDeps,
} from '../application/search/interpret-query-runner.js';

export type { InterpretQueryRunner, InterpretQueryRunnerDeps };

/**
 * Eval / integration-only interpret wiring. Not part of the production
 * `Container` — planner-only trace has no live HTTP surface after V2 cutover.
 */
export function buildInterpretQueryRunnerForEval(
  deps: InterpretQueryRunnerDeps,
): InterpretQueryRunner {
  return buildInterpretQueryRunner(deps);
}
