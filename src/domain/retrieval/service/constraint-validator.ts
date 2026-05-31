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
 * Every dropped or unrecognized constraint logs through a module-scoped
 * `Map` keyed by `(tier, attribute, reason)`. The first sighting always
 * logs; subsequent occurrences are re-logged whenever EITHER
 * {@link FIRST_SEEN_TTL_MS} has elapsed since the last warn OR
 * {@link FIRST_SEEN_COUNT_THRESHOLD} additional occurrences have piled up.
 * The silent-skip counter increments on every call regardless of throttle
 * state — it remains the SSoT for quantitative volume.
 */

import type { NormalizedConstraint } from '../../shared/types/index.js';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';
import { MS_PER_HOUR } from '../../shared/utils/time-units.js';
import {
  classifyConstraintRepresentability,
  hardConstraintsToSparseFilterTokens,
  type ConstraintRepresentability,
} from './constraint-to-sparse-filter-tokens.js';
import {
  resolveSoftIntentStrategy,
  type SoftIntentPrimaryStrategy,
} from '../../query/service/soft-intent-strategy-table.js';

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
  readonly strategyPrimary?: SoftIntentPrimaryStrategy | undefined;
  readonly retrievalUnsupportedReason?: string | undefined;
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
 * Re-log throttle window for the first-seen cache. After the very first warn
 * for a `(tier, attribute, reason)` triplet, the same triplet is re-logged
 * only when AT LEAST ONE of two conditions trips:
 *
 *  - {@link FIRST_SEEN_TTL_MS} has elapsed since the previous warn — keeps
 *    long-running processes from going permanently silent on a recurring
 *    silent-drop. 1h chosen as the operator-pager / dashboard refresh
 *    cadence: shorter would risk hot-path log spam during incident
 *    backfills; longer would let a regressing planner go unreported for a
 *    full ops shift.
 *  - {@link FIRST_SEEN_COUNT_THRESHOLD} additional occurrences have piled
 *    up since the previous warn — catches high-volume drops that out-pace
 *    the TTL. 1000 chosen because the silent-skip counter is the
 *    authoritative volume signal; the log only needs to fire often enough
 *    that grep-based incident response still surfaces the event when the
 *    counter dashboard is unavailable.
 *
 * Either condition independently triggers a re-warn; whichever trips first
 * wins. The counter (`globalSilentSkipCounter`) increments on every call
 * regardless of throttle state — it remains the SSoT for quantitative
 * volume. The log is purely the qualitative "this is happening" surface.
 */
// Rule 30/time-units SSoT: 1h derives from MS_PER_HOUR in
// @domain/shared/utils/time-units — do NOT re-multiply MS_PER_SECOND *
// SECONDS_PER_MINUTE * MINUTES_PER_HOUR locally (the previous copy drifted
// from the shared unit definitions).
const FIRST_SEEN_TTL_MS = MS_PER_HOUR;
const FIRST_SEEN_COUNT_THRESHOLD = 1000;

/**
 * Cache entry tracking when a `(tier, attribute, reason)` triplet was last
 * logged and how many silent occurrences have accumulated since that log.
 *
 *  - `lastLoggedAt`: the timestamp (`Date.now()`) of the most recent warn
 *    emission for this triplet. Used to evaluate the TTL window.
 *  - `silentCount`: count of telemetry calls that observed this triplet
 *    AFTER `lastLoggedAt` without emitting a log. Reset to 0 each time the
 *    log fires; compared against {@link FIRST_SEEN_COUNT_THRESHOLD}.
 */
interface FirstSeenLogEntry {
  lastLoggedAt: number;
  silentCount: number;
}

/**
 * Module-scoped first-seen cache for the telemetry log. The map key is a
 * stable triplet `(tier, attribute, reason)` so a triplet is verbose-logged
 * once per process AND then re-logged on every TTL/threshold trip. Counter
 * increments still fire on every call so operators retain quantitative
 * visibility through the silent-skip counter regardless of throttle state.
 */
const FIRST_SEEN_LOG_CACHE: Map<string, FirstSeenLogEntry> = new Map();

function firstSeenKey(
  tier: ValidatedConstraintTier,
  attribute: string,
  reason: string,
): string {
  return `${tier}|${attribute}|${reason}`;
}

/**
 * Returns `true` when the caller SHOULD emit a fresh warn for this triplet,
 * AND mutates the cache to reflect the decision. Centralising the decision
 * + bookkeeping in one helper keeps the dropped/unrecognized branches in
 * {@link emitConstraintValidationTelemetry} symmetric.
 *
 *  - First-ever sighting of a triplet → emit, init entry with
 *    `silentCount = 0`.
 *  - Cached + TTL elapsed → emit, reset `lastLoggedAt = now`,
 *    `silentCount = 0`.
 *  - Cached + `silentCount + 1 >= FIRST_SEEN_COUNT_THRESHOLD` → emit,
 *    keep original `lastLoggedAt` (so TTL is independent of count-driven
 *    re-warns), reset `silentCount = 0`. Note we compare on the
 *    POST-increment value so the threshold semantic is "every Nth
 *    occurrence, starting with the Nth".
 *  - Else → stay silent, `silentCount++`.
 *
 * `nowFn` is injected so unit tests can advance time deterministically
 * without `vi.useFakeTimers()` (which leaks into other module-scoped
 * timers).
 */
function shouldEmitFirstSeenLog(
  key: string,
  nowFn: () => number,
): boolean {
  const now = nowFn();
  const entry = FIRST_SEEN_LOG_CACHE.get(key);
  if (entry === undefined) {
    FIRST_SEEN_LOG_CACHE.set(key, { lastLoggedAt: now, silentCount: 0 });
    return true;
  }
  if (now - entry.lastLoggedAt >= FIRST_SEEN_TTL_MS) {
    entry.lastLoggedAt = now;
    entry.silentCount = 0;
    return true;
  }
  const nextSilentCount = entry.silentCount + 1;
  if (nextSilentCount >= FIRST_SEEN_COUNT_THRESHOLD) {
    entry.silentCount = 0;
    return true;
  }
  entry.silentCount = nextSilentCount;
  return false;
}

/**
 * Input shape for {@link validateConstraintBundle}. Intentionally NARROWER
 * than the full {@link ConstraintBundle}: the validator is the compile-time
 * gate for the **Vespa YQL emission path**, and only `hard` + `soft`
 * constraints reach that path
 * ({@link hardConstraintsToSparseFilterTokens} /
 * {@link softConstraintsToOptionalFilterTokens} both take only those tiers).
 *
 * `ConstraintBundle.inferred` exists for downstream **evidence annotation**
 * (see `annotateCandidateConstraintEvidenceBatch` in candidate-pool) — it
 * does not become a Vespa filter token. Accepting the full bundle here
 * would silently drop the `inferred` tier and create a false impression of
 * coverage; the narrow input forces callers to make the scope explicit.
 *
 * If a future change ever routes inferred constraints into YQL filter
 * emission, extend this shape with an `inferred` field AND walk it in
 * {@link validateConstraintBundle} — never re-accept the full
 * ConstraintBundle without the corresponding loop body.
 */
export interface ValidatableConstraintTiers {
  readonly hard: ReadonlyArray<NormalizedConstraint>;
  readonly soft: ReadonlyArray<NormalizedConstraint>;
}

/**
 * Walks the YQL-emission constraint tiers (hard + soft) and produces a
 * structured report partitioning every constraint into accepted / dropped
 * / unrecognized.
 *
 * Pure function — no I/O, no logging side effects, no global state mutated.
 * Telemetry side effects live in {@link emitConstraintValidationTelemetry}
 * so callers (and tests) can run validation without firing logs.
 *
 * Scope is intentionally narrow — see {@link ValidatableConstraintTiers}
 * for the rationale behind excluding the `inferred` tier.
 */
export function validateConstraintBundle(
  bundle: ValidatableConstraintTiers,
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
  const softIntentStrategy = resolveSoftIntentStrategy(constraint.attribute);
  const entry: ValidatedConstraintEntry = { constraint, tier, representability };
  const emitsHardFilterTokens = tier === 'hard'
    ? hardConstraintsToSparseFilterTokens([constraint]).length > 0
    : false;

  if (tier === 'hard') {
    if (
      (representability === 'hard_filterable' || representability === 'soft_promotable')
      && emitsHardFilterTokens
    ) {
      // soft_promotable attributes (e.g. critic_score_min via SOFT_PROMOTION_TOKEN_SPEC)
      // are accepted in the hard tier too — the compile path treats them as
      // hard constraints when placed in `bundle.hard`.
      accepted.push(entry);
      return;
    }
    if (
      SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)
      || representability === 'hard_filterable'
      || representability === 'soft_promotable'
    ) {
      // Hard-placed ranking-only attribute → drop (planner mis-classified
      // a soft signal as a hard constraint; the compile path will silently
      // emit zero tokens).
      dropped.push({
        ...entry,
        reason: 'hard_tier_not_filterable',
        ...(softIntentStrategy !== undefined
          ? {
              strategyPrimary: softIntentStrategy.primaryStrategy,
              ...(softIntentStrategy.retrievalUnsupportedReason !== undefined
                ? { retrievalUnsupportedReason: softIntentStrategy.retrievalUnsupportedReason }
                : {}),
            }
          : {}),
      });
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
    dropped.push({
      ...entry,
      reason: 'soft_tier_not_promotable',
      ...(softIntentStrategy !== undefined
        ? {
            strategyPrimary: softIntentStrategy.primaryStrategy,
            ...(softIntentStrategy.retrievalUnsupportedReason !== undefined
              ? { retrievalUnsupportedReason: softIntentStrategy.retrievalUnsupportedReason }
              : {}),
          }
        : {}),
    });
    return;
  }
  if (representability === 'hard_filterable') {
    // Hard-filterable attribute placed in the soft tier — promotion path
    // will silently no-op unless the attribute also has a SOFT_PROMOTION_TOKEN_SPEC
    // entry (caught by the soft_promotable branch above). Mark as dropped so
    // callers see the silent-no-op surface.
    dropped.push({
      ...entry,
      reason: 'soft_tier_not_promotable',
      ...(softIntentStrategy !== undefined
        ? {
            strategyPrimary: softIntentStrategy.primaryStrategy,
            ...(softIntentStrategy.retrievalUnsupportedReason !== undefined
              ? { retrievalUnsupportedReason: softIntentStrategy.retrievalUnsupportedReason }
              : {}),
          }
        : {}),
    });
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
 *  - For each unique `(tier, attribute, reason)` triplet, emits a
 *    `warn`/`error`-level log on first sighting AND on every TTL trip
 *    ({@link FIRST_SEEN_TTL_MS}) or count threshold trip
 *    ({@link FIRST_SEEN_COUNT_THRESHOLD}), whichever comes first.
 *    Subsequent occurrences inside the throttle window stay silent in the
 *    log. The counter remains authoritative for operator-facing volume.
 *
 * `unrecognized` entries are NOT thrown here; the caller decides whether
 * to fail closed (recommended for production) or degrade gracefully
 * (recommended for replay / introspection).
 *
 * @param report     The report from {@link validateConstraintBundle}.
 * @param context    Optional contextual fields (queryClass, requestId, …)
 *                   appended to every log entry.
 * @param options    Optional injection hooks. `nowFn` exists so unit tests
 *                   can advance the throttle clock deterministically
 *                   without resorting to `vi.useFakeTimers()` (which would
 *                   leak into unrelated module-scoped timers). Production
 *                   callers MUST NOT pass this; defaults to `Date.now`.
 */
export function emitConstraintValidationTelemetry(
  report: ConstraintValidationReport,
  context?: Readonly<Record<string, string | number | undefined>>,
  options?: { readonly nowFn?: () => number },
): void {
  const nowFn = options?.nowFn ?? Date.now;

  for (const entry of report.dropped) {
    globalSilentSkipCounter.increment('constraint_validator_dropped', {
      tier: entry.tier,
      attribute: entry.constraint.attribute,
      reason: entry.reason,
    });
    const key = firstSeenKey(entry.tier, entry.constraint.attribute, entry.reason);
    if (shouldEmitFirstSeenLog(key, nowFn)) {
      bootstrapLogger.warn(
        {
          event: 'constraint_validator.dropped',
          tier: entry.tier,
          attribute: entry.constraint.attribute,
          operator: entry.constraint.operator,
          reason: entry.reason,
          representability: entry.representability,
          strategy_primary: entry.strategyPrimary,
          retrieval_unsupported_reason: entry.retrievalUnsupportedReason,
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
    if (shouldEmitFirstSeenLog(key, nowFn)) {
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
