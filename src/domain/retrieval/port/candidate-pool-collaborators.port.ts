/**
 * Collaborator ports for {@link CandidatePoolService}.
 *
 * DIP seam (behavior-preserving): the candidate-pool orchestrator historically
 * instantiated its four collaborators (`RetrievalProfileService`,
 * `CascadeRouter`, `ConstraintFilter`, `CandidateAssembler`) directly in its
 * constructor via `new`. That hard-wires the concrete types and blocks mock
 * injection in unit tests.
 *
 * These ports expose ONLY the public method surface that
 * `CandidatePoolService` actually consumes today. They are derived with `Pick`
 * from the concrete classes so the signatures (including the classes' private
 * return types such as `PhaseDispatchDecision` / `AssemblyResult`) stay in
 * exact, drift-free sync with the implementations — no signature is duplicated
 * by hand, and no internal interface needs to be exported.
 *
 * The concrete classes remain the default constructor wiring, so runtime
 * behavior is byte-equivalent; the seam is purely additive (optional
 * injection).
 */
import type { RetrievalProfileService } from '../service/retrieval-profile.js';
import type { CascadeRouter } from '../service/cascade-router.js';
import type { ConstraintFilter } from '../service/constraint-filter.js';
import type { CandidateAssembler } from '../service/candidate-assembly.js';

/**
 * Profile resolution surface consumed by the candidate pool
 * (`getProfile`; the channel-mix / execution variants are included for
 * completeness of the public profile contract).
 */
export type RetrievalProfilePort = Pick<
  RetrievalProfileService,
  'getProfile' | 'getChannelMix' | 'getExecutionProfile' | 'getExecutionChannelMix'
>;

/**
 * Cascade dispatch surface consumed by the candidate pool (`getDispatchDecision`;
 * `getPhases` is part of the same public router contract).
 */
export type CascadeRouterPort = Pick<
  CascadeRouter,
  'getDispatchDecision' | 'getPhases'
>;

/**
 * Hard-constraint filtering surface consumed by the candidate pool
 * (`applyHardFiltersWithDropLog`; `applyHardFilters` is part of the same
 * public filter contract).
 */
export type ConstraintFilterPort = Pick<
  ConstraintFilter,
  'applyHardFilters' | 'applyHardFiltersWithDropLog'
>;

/**
 * Final candidate-set assembly surface consumed by the candidate pool.
 */
export type CandidateAssemblerPort = Pick<CandidateAssembler, 'assemble'>;
