/**
 * Constraint-validator — compile-time gate between the planner's
 * {@link ConstraintBundle} and the Vespa YQL emission path
 * ({@link hardConstraintsToSparseFilterTokens} +
 * {@link softConstraintsToOptionalFilterTokens}).
 *
 * ## Why this exists
 *
 * Before this module, any planner-emitted constraint whose attribute had no
 * `case` branch in `constraint-to-sparse-filter-tokens.ts` (or whose attribute
 * was not registered in {@link FILTER_TOKEN_REGISTRY}) was silently dropped at
 * YQL emission time:
 *
 *   - No diagnostic logged → invisible to operators
 *   - No ranking penalty → user's stated intent contributes nothing
 *   - No fallback → the constraint becomes a no-op
 *
 * Symptoms in production: a planner extracts `appellation='Barolo'` as a
 * hard constraint (or a brand-new attribute the team forgot to register),
 * Vespa returns zero hits or full corpus, and the system clarifies / fails
 * for a query it could have handled.
 *
 * ## What it does
 *
 * For every hard + soft constraint in a bundle, asks
 * {@link classifyConstraintRepresentability}:
 *  - Is the attribute hard-filterable?
 *  - Is it soft-promotable?
 *  - Is it intentionally ranking-only (member of
 *    {@link SOFT_CONSTRAINT_ATTRIBUTES})?
 *  - Or is it unknown / silently dropped?
 *
 * Walks both tiers and returns three buckets:
 *
 *  - {@link ConstraintValidationReport.accepted}: constraint will flow
 *    through to Vespa as a registered filter token (or as a structured
 *    soft-boost in `retrieval-plan-builder.ts`).
 *  - {@link ConstraintValidationReport.dropped}: attribute is known to the
 *    domain but the chosen tier cannot express it as a Vespa filter
 *    (e.g. `style` / `price_band` / `drinking_window` placed in the soft
 *    tier — these are SOFT_CONSTRAINT_ATTRIBUTES with no
 *    {@link SOFT_PROMOTION_TOKEN_SPEC} entry). The constraint still flows
 *    into `softBoosts` for ranking; this bucket exists to surface the
 *    expectation gap.
 *  - {@link ConstraintValidationReport.unrecognized}: attribute is unknown
 *    in both compile paths AND not in {@link SOFT_CONSTRAINT_ATTRIBUTES} —
 *    the constraint will be silently dropped. Treated as a planner bug;
 *    callers should throw.
 *
 * ## Telemetry
 *
 * Every dropped or unrecognized constraint logs ONCE per process via a
 * module-scoped `Map` keyed by `(tier, attribute, reason)`. Subsequent
 * occurrences increment the silent-skip counter but stay silent in the log
 * to avoid hot-path spam.
 */

import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';
import {
  classifyConstraintRepresentability,
  type ConstraintRepresentability,
} from './constraint-to-sparse-filter-tokens.js';

/** Which bundle tier the constraint was sourced from. */
export type ValidatedConstraintTier = 'hard' | 'soft';

/**
 * Reason a constraint was placed in the `dropped` bucket.
 *
 *  - `soft_tier_not_promotable`: the attribute is intentionally ranking-only
 *    (member of {@link SOFT_CONSTRAINT_ATTRIBUTES}) and has no
 *    {@link SOFT_PROMOTION_TOKEN_SPEC} entry. The constraint will still
 *    influence ranking via `softBoosts`, but it will NEVER become a Vespa
 *    WHERE-clause filter.
 *  - `hard_tier_not_filterable`: the attribute has no
 *    {@link HARD_FILTERABLE_ATTRIBUTES} entry but IS a recognised soft /
 *    ranking-only attribute. Hard placement is a planner mis-classification
 *    (would have silently produced zero tokens). The validator demotes by
 *    surfacing this as `dropped` (not `unrecognized`); the existing soft
 *    bundle will still carry ranking signal if the planner also classified
 *    it correctly elsewhere.
 */
export type DroppedConstraintReason =
  | 'soft_tier_not_promotable'
  | 'hard_tier_not_filterable';

/**
 * Reason a constraint was placed in the `unrecognized` bucket — both compile
 * paths have no idea what to do with the attribute.
 */
export type UnrecognizedConstraintReason =
  | 'attribute_not_in_compile_path';

export interface ValidatedConstraintEntry {
  readonly constraint: NormalizedConstraint;
  readonly tier: ValidatedConstraintTier;
  readonly representability: ConstraintRepresentability;
}

export interface DroppedConstraintEntry extends ValidatedConstraintEntry {
  readonly reason: DroppedConstraintReason;
}

export interface UnrecognizedConstraintEntry extends ValidatedConstraintEntry {
  readonly reason: UnrecognizedConstraintReason;
}

export interface ConstraintValidationReport {
  /** Constraints that flow through normally. */
  readonly accepted: readonly ValidatedConstraintEntry[];
  /**
   * Constraints whose attribute is known to the domain but the chosen
   * tier cannot express it as a Vespa filter. Caller should emit telemetry
   * and (optionally) attach a ranking-penalty fallback signal.
   */
  readonly dropped: readonly DroppedConstraintEntry[];
  /**
   * Constraints whose attribute is unknown in every compile path. Caller
   * MUST throw — these are planner bugs that silently degrade retrieval.
   */
  readonly unrecognized: readonly UnrecognizedConstraintEntry[];
}

/**
 * Module-scoped first-seen cache for the telemetry log. The map key is a
 * stable triplet so a `(tier, attribute, reason)` combination is only
 * verbose-logged once per process. Counter increments still fire on every
 * call so operators retain quantitative visibility.
 */
const FIRST_SEEN_LOG_CACHE: Set<string> = new Set();

function firstSeenKey(
  tier: ValidatedConstraintTier,
  attribute: string,
  reason: string,
): string {
  return `${tier}|${attribute}|${reason}`;
}

/**
 * Walks a {@link ConstraintBundle} and produces a structured report
 * partitioning every constraint into accepted / dropped / unrecognized.
 *
 * Pure function — no I/O, no logging side effects, no global state mutated.
 * Telemetry side effects live in {@link emitConstraintValidationTelemetry}
 * so callers (and tests) can run validation without firing logs.
 */
export function validateConstraintBundle(
  bundle: ConstraintBundle,
): ConstraintValidationReport {
  const accepted: ValidatedConstraintEntry[] = [];
  const dropped: DroppedConstraintEntry[] = [];
  const unrecognized: UnrecognizedConstraintEntry[] = [];

  for (const constraint of bundle.hard) {
    classifyAndPartition(constraint, 'hard', accepted, dropped, unrecognized);
  }
  for (const constraint of bundle.soft) {
    classifyAndPartition(constraint, 'soft', accepted, dropped, unrecognized);
  }

  return { accepted, dropped, unrecognized };
}

function classifyAndPartition(
  constraint: NormalizedConstraint,
  tier: ValidatedConstraintTier,
  accepted: ValidatedConstraintEntry[],
  dropped: DroppedConstraintEntry[],
  unrecognized: UnrecognizedConstraintEntry[],
): void {
  const representability = classifyConstraintRepresentability(constraint.attribute);
  const entry: ValidatedConstraintEntry = { constraint, tier, representability };

  if (tier === 'hard') {
    if (representability === 'hard_filterable' || representability === 'soft_promotable') {
      // soft_promotable attributes (e.g. critic_score_min via SOFT_PROMOTION_TOKEN_SPEC)
      // are accepted in the hard tier too — the compile path treats them as
      // hard constraints when placed in `bundle.hard`.
      accepted.push(entry);
      return;
    }
    if (SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
      // Hard-placed ranking-only attribute → drop (planner mis-classified
      // a soft signal as a hard constraint; the compile path will silently
      // emit zero tokens).
      dropped.push({ ...entry, reason: 'hard_tier_not_filterable' });
      return;
    }
    unrecognized.push({ ...entry, reason: 'attribute_not_in_compile_path' });
    return;
  }

  // tier === 'soft'
  if (representability === 'soft_promotable') {
    accepted.push(entry);
    return;
  }
  if (SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
    // Soft + recognised-soft-attribute but no SOFT_PROMOTION_TOKEN_SPEC entry
    // → ranking-only by design. The intent still reaches the ranker via
    // `softBoosts` in retrieval-plan-builder, but it will NEVER become a
    // Vespa WHERE-clause filter. Surface this so callers can attach a
    // fallback-penalty signal if desired.
    dropped.push({ ...entry, reason: 'soft_tier_not_promotable' });
    return;
  }
  if (representability === 'hard_filterable') {
    // Hard-filterable attribute placed in the soft tier — promotion path
    // will silently no-op unless the attribute also has a SOFT_PROMOTION_TOKEN_SPEC
    // entry (caught by the soft_promotable branch above). Mark as dropped so
    // callers see the silent-no-op surface.
    dropped.push({ ...entry, reason: 'soft_tier_not_promotable' });
    return;
  }
  unrecognized.push({ ...entry, reason: 'attribute_not_in_compile_path' });
}

/**
 * Emits structured telemetry for a validation report. Call once per
 * candidate-pool / compile-path invocation.
 *
 * Side effects:
 *  - For each `dropped` and `unrecognized` entry, increments
 *    {@link globalSilentSkipCounter} ALWAYS.
 *  - For each unique `(tier, attribute, reason)` triplet, emits a single
 *    `warn`-level log per process. Subsequent occurrences stay silent in
 *    the log to avoid hot-path spam. The counter remains authoritative for
 *    operator-facing volume.
 *
 * `unrecognized` entries are NOT thrown here; the caller decides whether
 * to fail closed (recommended for production) or degrade gracefully
 * (recommended for replay / introspection).
 *
 * @param report     The report from {@link validateConstraintBundle}.
 * @param context    Optional contextual fields (queryClass, requestId, …)
 *                   appended to every log entry.
 */
export function emitConstraintValidationTelemetry(
  report: ConstraintValidationReport,
  context?: Readonly<Record<string, string | number | undefined>>,
): void {
  for (const entry of report.dropped) {
    globalSilentSkipCounter.increment('constraint_validator_dropped', {
      tier: entry.tier,
      attribute: entry.constraint.attribute,
      reason: entry.reason,
    });
    const key = firstSeenKey(entry.tier, entry.constraint.attribute, entry.reason);
    if (!FIRST_SEEN_LOG_CACHE.has(key)) {
      FIRST_SEEN_LOG_CACHE.add(key);
      bootstrapLogger.warn(
        {
          event: 'constraint_validator.dropped',
          tier: entry.tier,
          attribute: entry.constraint.attribute,
          operator: entry.constraint.operator,
          reason: entry.reason,
          representability: entry.representability,
          mapping_version: entry.constraint.mapping_version,
          source_phrase: entry.constraint.source_phrase,
          ...(context ?? {}),
        },
        `[constraint-validator] dropped ${entry.tier} constraint on '${entry.constraint.attribute}' (${entry.reason})`,
      );
    }
  }

  for (const entry of report.unrecognized) {
    globalSilentSkipCounter.increment('constraint_validator_unrecognized', {
      tier: entry.tier,
      attribute: entry.constraint.attribute,
      reason: entry.reason,
    });
    const key = firstSeenKey(entry.tier, entry.constraint.attribute, entry.reason);
    if (!FIRST_SEEN_LOG_CACHE.has(key)) {
      FIRST_SEEN_LOG_CACHE.add(key);
      bootstrapLogger.error(
        {
          event: 'constraint_validator.unrecognized',
          tier: entry.tier,
          attribute: entry.constraint.attribute,
          operator: entry.constraint.operator,
          reason: entry.reason,
          mapping_version: entry.constraint.mapping_version,
          source_phrase: entry.constraint.source_phrase,
          ...(context ?? {}),
        },
        `[constraint-validator] UNRECOGNIZED ${entry.tier} constraint on '${entry.constraint.attribute}' — planner bug; silently dropped at YQL emission`,
      );
    }
  }
}

/**
 * Thrown when {@link assertNoUnrecognizedConstraints} finds at least one
 * unrecognized constraint. The message includes the full diagnostic context
 * (attributes + count) so operators can locate the planner bug without
 * having to grep structured logs.
 */
export class UnrecognizedConstraintError extends Error {
  readonly attributes: readonly string[];
  constructor(entries: readonly UnrecognizedConstraintEntry[]) {
    const attrs = entries.map((e) => `${e.tier}:${e.constraint.attribute}`);
    super(
      `[constraint-validator] ${entries.length} unrecognized constraint(s) — ` +
      `planner emitted attributes with no compile-path representation: [${attrs.join(', ')}]. ` +
      'This is a planner / extractor bug; the constraint would be silently dropped at YQL emission.',
    );
    this.name = 'UnrecognizedConstraintError';
    this.attributes = attrs;
  }
}

/**
 * Throws {@link UnrecognizedConstraintError} if the report contains any
 * unrecognized constraints. Call after
 * {@link emitConstraintValidationTelemetry} so the diagnostic log is
 * preserved even when the throw aborts the request.
 */
export function assertNoUnrecognizedConstraints(
  report: ConstraintValidationReport,
): void {
  if (report.unrecognized.length === 0) return;
  throw new UnrecognizedConstraintError(report.unrecognized);
}

/**
 * Test-only — reset the first-seen log cache so each unit test starts from
 * a clean state. NEVER call from production code paths; the cache is
 * process-scoped by design to keep hot paths quiet.
 *
 * @internal
 */
export function __resetConstraintValidatorLogCacheForTests(): void {
  FIRST_SEEN_LOG_CACHE.clear();
}
