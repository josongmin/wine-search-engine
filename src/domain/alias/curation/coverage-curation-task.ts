/**
 * Entity Lookup V2 — coverage-hole → curation task substrate (T-ELV2-03).
 *
 * Closes the DoD §2 loop: a hot-entity COVERAGE HOLE (a query the gold says
 * should resolve but the engine could not — e.g. `dom perignon` / `돔페리뇽`)
 * becomes a structured CURATION TASK that an operator triages into an alias
 * proposal. This is the pure domain core — it does not write; the staged
 * proposal write plane (operator/ETL) persists tasks into the existing
 * `alias_proposals` substrate (provenance + approval state).
 *
 * Pure domain (no I/O). Intentionally NOT a complete alias proposal: a coverage
 * hole knows the SURFACE that failed, not the target entity — assigning the
 * target is the operator's curation decision. The task therefore carries a
 * SUGGESTED alias type derived from the hole's class, never a fabricated target.
 */

import type { AliasType } from '../model/alias.js';

/** Why a surface entered the curation queue (mirrors the coverage hole class). */
export interface CoverageHoleInput {
  /** The query surface that failed to resolve. */
  readonly surfaceForm: string;
  /** Hotset class tag (e.g. `hot_entity_coverage`, `transliteration`). */
  readonly holeClass: string;
  /** The engine status actually observed (failed / ambiguous / redirect). */
  readonly observedStatus: string;
}

export const CURATION_TASK_STATUSES = ['needs_target', 'ready_for_review'] as const;
export type CurationTaskStatus = (typeof CURATION_TASK_STATUSES)[number];

export interface CurationTask {
  readonly surfaceForm: string;
  readonly holeClass: string;
  readonly observedStatus: string;
  /**
   * Alias type the operator most likely needs to add, inferred from the hole
   * class. A SUGGESTION only — the operator confirms the type + target entity.
   */
  readonly suggestedAliasType: AliasType;
  /** A coverage hole has no target yet — always `needs_target` at creation. */
  readonly status: CurationTaskStatus;
  /** Human-facing rationale for the curation queue. */
  readonly reason: string;
}

/**
 * Map a coverage-hole class to the alias type an operator most likely needs.
 * Conservative: defaults to `canonical` (the safest curated type) when the
 * class does not clearly imply a phonetic/transliteration/abbreviation gap.
 */
export function suggestAliasTypeForHole(holeClass: string): AliasType {
  const c = holeClass.toLowerCase();
  if (c.includes('translit') || c.includes('korean') || c.includes('hangul')) {
    return 'translation';
  }
  if (c.includes('phonetic') || c.includes('typo') || c.includes('misspell')) {
    return 'misspelling';
  }
  if (c.includes('abbrev') || c.includes('initial')) {
    return 'abbreviation';
  }
  return 'canonical';
}

/**
 * Build curation tasks from coverage holes. One task per hole; deterministic
 * and order-preserving. De-duplicates by normalized surface form so the same
 * unresolved surface is not queued twice.
 */
export function buildCurationTasks(holes: readonly CoverageHoleInput[]): readonly CurationTask[] {
  const seen = new Set<string>();
  const tasks: CurationTask[] = [];
  for (const hole of holes) {
    const key = hole.surfaceForm.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tasks.push({
      surfaceForm: hole.surfaceForm,
      holeClass: hole.holeClass,
      observedStatus: hole.observedStatus,
      suggestedAliasType: suggestAliasTypeForHole(hole.holeClass),
      status: 'needs_target',
      reason: `Hot-entity coverage hole (${hole.holeClass}): "${hole.surfaceForm}" resolved as "${hole.observedStatus}" — assign a target entity + alias to close it.`,
    });
  }
  return tasks;
}
