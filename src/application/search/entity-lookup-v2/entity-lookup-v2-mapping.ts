/**
 * Entity Lookup V2 — pure mapping helpers (status, reason text, view projection).
 *
 * Kept separate from the use case so the projection logic is unit-testable in
 * isolation and so the use case stays focused on orchestration.
 */

import type { DecisionStatus } from '../../../domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { LookupAdmissionVerdict, LookupV2Status } from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { NormalizedQueryViewsView } from './entity-lookup-v2.dto.js';

/**
 * Engine version surfaced in `meta.version`. Bumped when the V2 decision
 * contract changes in an observable way. Independent of the HTTP catalog
 * version, which tracks the surface, not the engine.
 */
export const LOOKUP_V2_ENGINE_VERSION = 'entity-lookup-v2/1.0.0';

/**
 * Map the resolver's advisory status to the V2 terminal status. The resolver
 * never produces `redirect_discovery` — that is an admission-gate-only outcome
 * decided ahead of resolution.
 */
export function mapResolverStatusToLookupStatus(
  status: DecisionStatus,
): Exclude<LookupV2Status, 'redirect_discovery'> {
  switch (status) {
    case 'resolved':
      return 'resolved';
    case 'ambiguous':
      return 'ambiguous';
    case 'failed':
    default:
      return 'failed';
  }
}

/** Build the explicit normalized-query-views artifact for the response. */
export function buildNormalizedQueryViewsView(plan: QueryPlanV1): NormalizedQueryViewsView {
  const v = plan.normalizedQueryViews;
  if (v === undefined) {
    const q = plan.normalizedQuery;
    return {
      raw: plan.rawQuery,
      strict: q,
      accentless: q,
      compact: q.replace(/[^\p{L}\p{N}]/gu, ''),
      vintageCanonicalized: q,
      vintageStripped: q,
      lookupVariants: [q],
    };
  }
  return {
    raw: v.raw,
    strict: v.strict,
    accentless: v.accentless,
    compact: v.compact,
    vintageCanonicalized: v.vintageCanonicalized,
    vintageStripped: v.vintageStripped,
    ...(v.transliterated !== undefined ? { transliterated: v.transliterated } : {}),
    ...(v.phoneticCompact !== undefined ? { phoneticCompact: v.phoneticCompact } : {}),
    lookupVariants: v.lookupVariants,
  };
}

/**
 * Human-facing one-line decision reason. Precision-first wording: a non-resolve
 * is framed as "could not confidently identify", never as a soft success.
 */
export function decisionReasonText(
  status: LookupV2Status,
  reasonCode: string,
  admission: LookupAdmissionVerdict,
): string {
  switch (status) {
    case 'resolved':
      return 'Confidently resolved to a single wine entity.';
    case 'ambiguous':
      return 'Multiple plausible wines match this query — clarification is required.';
    case 'redirect_discovery':
      return admission.detail.length > 0
        ? admission.detail
        : 'This looks like a concept query — redirected to discovery search.';
    case 'failed':
    default:
      if (admission.decision === 'reject') {
        return admission.detail.length > 0
          ? admission.detail
          : 'The query does not reference a resolvable wine entity.';
      }
      if (reasonCode === 'hard_constraint_violation') {
        return 'The query contains contradictory constraints and cannot be resolved.';
      }
      return 'Could not confidently identify a wine for this query.';
  }
}
