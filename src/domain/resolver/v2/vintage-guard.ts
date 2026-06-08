/**
 * Entity Lookup V2 — vintage-mismatch resolve guard.
 *
 * Precision-first downgrade: when a query carries an EXPLICIT vintage token
 * (e.g. `오퍼스원 2019`, `Opus One 2019`) but the resolved entity's vintage is a
 * DIFFERENT year (`Opus One 2018`), that is NOT a confident single resolve — the
 * caller asked for a specific vintage we did not return. Downgrading such a
 * `resolved` to `ambiguous` (multi-vintage) prevents the wrong-positive that was
 * the sole 2026-06-02 shadow cutover blocker.
 *
 * Exact integer year comparison via the query-aware vintage SSoT — no heuristic,
 * no fuzzy matching. Domain leaf: imports only shared utils.
 */

import { extractQueryVintageYear, extractVintageYear } from '../../shared/utils/vintage.js';

/** Machine-readable reason code surfaced when the guard downgrades a resolve. */
export const VINTAGE_MISMATCH_REASON_CODE = 'vintage_mismatch_downgrade';

/**
 * True iff the query carries an explicit vintage AND the candidate label carries
 * a vintage AND they differ. Returns false when either side has no vintage (then
 * there is nothing to contradict — no downgrade).
 */
export function shouldDowngradeForVintageMismatch(
  rawQuery: string,
  candidateLabel: string | undefined,
): boolean {
  if (candidateLabel === undefined) return false;
  const queryVintage = extractQueryVintageYear(rawQuery);
  if (queryVintage === null) return false;
  const candidateVintage = extractVintageYear(candidateLabel);
  if (candidateVintage === null) return false;
  return queryVintage !== candidateVintage;
}

/** Machine-readable reason code surfaced when a vintage-matching family sibling
 * is promoted over a vintage-blind incumbent. */
export const VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE = 'vintage_family_member_resolved';

/**
 * Minimum independent-channel agreement a promoted vintage sibling must carry.
 * Mirrors the reviewed-scope-target precision guard: a single-channel fuzzy recall
 * is not identity-bearing, so snapping to it would resurrect typo/no-match queries.
 */
export const MIN_VINTAGE_SIBLING_CHANNEL_AGREEMENT = 2;

/** Minimal candidate shape the vintage-sibling selector needs (a structural subset
 * of the use-case candidate view — keeps this a domain leaf with no app imports). */
export interface VintageSiblingCandidate {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly channelAgreement: number;
}

/**
 * Vintage-aware family-member selection — the precision-preserving DUAL of
 * {@link shouldDowngradeForVintageMismatch}.
 *
 * When a query carries an EXPLICIT vintage but the resolver could not produce a
 * confident single resolve (the verdict is ambiguous — either a vintage-mismatch
 * downgrade against a vintage-blind incumbent, or a multi-vintage family
 * collision), prefer the sibling ALREADY in the resolved candidate pool whose
 * vintage EXACTLY matches the query: the caller asked for a specific vintage we DO
 * host, the ambiguity is purely "which vintage", and the query answered it.
 *
 * Precision-first, returns undefined (→ caller keeps the ambiguous verdict) unless:
 *  - the query carries an explicit vintage,
 *  - EXACTLY ONE pooled candidate's label vintage equals the query vintage, and
 *  - that candidate carries multi-channel corroboration (≥ MIN agreement).
 *
 * Exact integer-year compare via the query-aware vintage SSoT — no heuristic, no
 * fuzzy matching. The caller gates this on an `ambiguous` verdict, so a confident
 * resolve is never overridden. Domain leaf: imports only shared utils.
 */
export function selectExplicitVintageFamilyMember(args: {
  readonly query: string;
  readonly candidates: readonly VintageSiblingCandidate[];
}): string | undefined {
  const queryVintage = extractQueryVintageYear(args.query);
  if (queryVintage === null) {
    return undefined;
  }
  const matches = args.candidates.filter((candidate) =>
    candidate.channelAgreement >= MIN_VINTAGE_SIBLING_CHANNEL_AGREEMENT
    && extractVintageYear(candidate.canonicalLabel) === queryVintage,
  );
  if (matches.length !== 1) {
    // Zero matches → nothing to promote; multiple → genuinely ambiguous, abstain.
    return undefined;
  }
  return matches[0]!.entityId;
}
