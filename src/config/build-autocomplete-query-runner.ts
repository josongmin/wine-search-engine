import {
  buildAutocompleteQueryRunner,
  type AutocompleteQueryRunner,
  type AutocompleteQueryRunnerDeps,
} from '../application/search/autocomplete-query-runner.js';

export type { AutocompleteQueryRunner, AutocompleteQueryRunnerDeps };

/**
 * Eval / integration-only autocomplete wiring. Not part of the production
 * `Container` — no live HTTP surface after the V2 cutover.
 */
export function buildAutocompleteQueryRunnerForEval(
  deps: AutocompleteQueryRunnerDeps,
): AutocompleteQueryRunner {
  return buildAutocompleteQueryRunner(deps);
}
