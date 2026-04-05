import type { EntityId } from '../../shared/types/index.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';

/**
 * Output of a learned (ML-based) entity matcher for a single candidate.
 */
export interface LearnedMatcherOutput {
  /** The entity that was scored. */
  readonly entityId: EntityId;

  /** Model's estimated probability that this entity matches the query, in [0, 1]. */
  readonly matchProbability: number;

  /** Identifier of the model that produced this score. */
  readonly modelId: string;

  /** Semantic version of the model. */
  readonly modelVersion: string;

  /**
   * Per-feature signal vector produced by the learned model (RFC-006 §5.2).
   *
   * Enables signal-level tracing and attribution of learned model decisions.
   * Each element corresponds to a feature in the model's input space.
   * Absent when the model does not expose a decomposed signal vector
   * (e.g. black-box endpoints or older model versions).
   */
  readonly matchSignalVector?: readonly number[] | undefined;
}

/**
 * Port for an optional ML-based entity matcher, per RFC-006 §5.2.
 *
 * When available, the learned matcher provides match probabilities that
 * can supplement or replace the heuristic weighted scoring function.
 * The calibrator still applies to the output.
 */
export interface LearnedMatcherPort {
  /**
   * Scores each candidate against the query using a learned model.
   *
   * @param query - The user's search query.
   * @param candidates - Pre-filtered candidates from the blocking stage.
   * @returns Match outputs for each candidate, unordered.
   */
  match(query: string, candidates: readonly ResolverCandidate[]): Promise<readonly LearnedMatcherOutput[]>;
}
