import type { EntityId } from '../../shared/types/index.js';

/**
 * A single candidate presented to the user during disambiguation.
 */
export interface ClarificationCandidate {
  /** Entity identifier for this candidate. */
  readonly entityId: EntityId;

  /** Display label. */
  readonly label: string;

  /** Features that distinguish this candidate from the others. */
  readonly distinguishingFeatures: readonly string[];
}

/**
 * Payload returned when the engine requires user clarification
 * before it can produce a definitive result.
 */
export interface ClarificationPayload {
  /** Human-readable explanation of why clarification is needed. */
  readonly reason: string;

  /** Candidate entities the user can choose from. */
  readonly candidates: readonly ClarificationCandidate[];

  /** The kind of suggestion being offered. */
  readonly suggestionType: 'disambiguation' | 'missing_info';
}
