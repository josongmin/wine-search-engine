/**
 * SOTA++ ground-truth annotation schema for agent benchmark scenarios.
 *
 * One annotation per scenario id. Loaded by the runner/scorer to drive
 * deterministic scoring of every dimension whose ground truth is known.
 *
 * Design contract:
 *   - All fields optional. Absence = "judge-only for that dimension".
 *   - Presence flips that dimension into deterministic mode (overrides judge).
 *   - Stored at `test/benchmark/agent/annotations/<scenarioId>.json` so the
 *     scenario file (`scenarios.*.ts`) stays minimal and annotators can churn
 *     JSON without recompiling TS sources.
 *   - `bench-self-validation.regression.test.ts` round-trips synthetic
 *     annotations through this schema to keep parse semantics stable.
 *
 * Why a separate file (not extending `ScenarioExpectation`):
 *   - Annotations are an ANNOTATOR product, not a SCENARIO-author product.
 *     They evolve on a different cadence (curated batches) than scenarios.
 *   - Decouples insight rule "annotated vs judge-only" (C5) from scenario
 *     count, so the bench can grow without inflating annotation counts.
 *
 * Aligned with CLAUDE.md §Schema quality bar: every numeric uses `.finite()`
 * / `.int()`, every array is bounded, the object is `.strict()` because this
 * is an authoring-time contract (not LLM tool input).
 */

import { z } from 'zod';
import type { ExpectedConstraint, ExpectedEntity, TerminationReason } from './scenario.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants — every magic number named (CLAUDE.md rule 15)
// ─────────────────────────────────────────────────────────────────────────

/** Max constraints per bucket — generous bound; current largest scenario has 8. */
const MAX_CONSTRAINTS_PER_BUCKET = 32;
/** Max expected entities per scenario — comparison queries top out around 4. */
const MAX_EXPECTED_ENTITIES = 16;
/** Max expected retrieval IDs (golden entity matches in tool results). */
const MAX_EXPECTED_RETRIEVAL_IDS = 64;
/** Max "must mention" / "must not mention" claim atoms per scenario. */
const MAX_CLAIM_ATOMS = 32;
/** Max rubric criteria items (free-form bullets the judge must verify). */
const MAX_RUBRIC_ITEMS = 16;
/** Hard upper bound on expected agent steps (matches scorer step budget). */
const MAX_EXPECTED_STEPS = 64;
/** Upper bound on annotator-supplied string lengths to keep JSON sane. */
const MAX_TEXT_LENGTH = 512;

// ─────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Annotation constraint atom.
 *
 * Mirrors the in-source `ExpectedConstraint` type but enforced at runtime by
 * Zod so external JSON cannot smuggle in malformed atoms. `value` accepts the
 * union shape because constraints range over scalars, lists, and numeric
 * ranges (price band, vintage range).
 */
export const constraintAtomSchema = z.object({
  attribute: z.string().min(1).max(MAX_TEXT_LENGTH),
  operator: z.enum(['=', '<=', '>=', 'range', 'in', 'exclude']),
  value: z.union([
    z.string().max(MAX_TEXT_LENGTH),
    z.number().finite(),
    z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_CONSTRAINTS_PER_BUCKET),
    z.array(z.number().finite()).max(MAX_CONSTRAINTS_PER_BUCKET),
    z.object({
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    }).strict(),
  ]),
}).strict();

/**
 * Bucketed constraint annotation. Mirrors scenario.expectedConstraints shape.
 */
export const expectedConstraintsSchema = z.object({
  hard: z.array(constraintAtomSchema).max(MAX_CONSTRAINTS_PER_BUCKET).optional(),
  soft: z.array(constraintAtomSchema).max(MAX_CONSTRAINTS_PER_BUCKET).optional(),
  inferred: z.array(constraintAtomSchema).max(MAX_CONSTRAINTS_PER_BUCKET).optional(),
}).strict();

export const expectedEntitySchema = z.object({
  surface: z.string().min(1).max(MAX_TEXT_LENGTH),
  canonical: z.string().min(1).max(MAX_TEXT_LENGTH),
  type: z.enum(['wine_type', 'country', 'region', 'appellation', 'grape_primary']),
}).strict();

export const expectedClaimsSchema = z.object({
  /** Claim atoms (canonical lower-case substrings) that MUST appear in the answer. */
  mustMention: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).max(MAX_CLAIM_ATOMS).optional(),
  /** Claim atoms that MUST NOT appear in the answer. */
  mustNotMention: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).max(MAX_CLAIM_ATOMS).optional(),
}).strict();

export const expectedStepsSchema = z.object({
  /** Min agent step count (inclusive). */
  min: z.number().int().min(0).max(MAX_EXPECTED_STEPS),
  /** Max agent step count (inclusive). */
  max: z.number().int().min(0).max(MAX_EXPECTED_STEPS),
}).strict().refine((s) => s.max >= s.min, {
  message: 'expectedSteps.max must be >= expectedSteps.min',
});

/** Termination reason union — mirrors scenario.ts `TerminationReason`. */
export const terminationReasonSchema: z.ZodType<TerminationReason> = z.enum([
  'answer', 'fallback', 'blocked', 'error', 'timeout',
]);

// ─────────────────────────────────────────────────────────────────────────
// Top-level annotation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Top-level scenario annotation. All dimensions optional — annotators provide
 * only what they have ground truth for. The runner/scorer (C1.2) reads this
 * and switches matching dimensions from judge-only to deterministic.
 *
 * Field semantics:
 *   - `expectedConstraints`: drives SCR/Slot F1 (already a scorer input via
 *     scenario.ts; the annotation overrides any inline value when present).
 *   - `expectedRetrievalIds`: at least one MUST appear in agent observations
 *     (canonical entity id token). Drives a deterministic retrieval-hit flag.
 *   - `expectedClaims.mustMention` / `mustNotMention`: hard substring contract
 *     on the final answer (NFKC + case-folded). Failure → answer-quality
 *     penalty AND a critical diagnostic (mustNotMention violations).
 *   - `expectedSteps`: enforced as [min, max] inclusive range on the agent's
 *     `stepCount`. Violations flag a `steps_out_of_range` diagnostic.
 *   - `expectedTerminationReason`: hard equality check against scored
 *     `terminationReason`.
 *   - `expectedRubric`: free-form bullets surfaced to the LLM judge ONLY when
 *     no inline rubric was supplied — the annotation is a fallback rubric.
 */
export const scenarioAnnotationSchema = z.object({
  /** Scenario id this annotation targets. Source of truth — file name should match. */
  scenarioId: z.number().int().min(0).max(100_000),
  /** Short human note: rationale for the annotation, source link, etc. */
  notes: z.string().max(MAX_TEXT_LENGTH).optional(),
  /** Annotator handle / email for audit. */
  annotatedBy: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  /** ISO 8601 UTC timestamp of when the annotation was authored / last updated. */
  annotatedAt: z.string().datetime({ offset: false }).optional(),

  expectedConstraints: expectedConstraintsSchema.optional(),
  expectedRetrievalIds: z.array(z.string().min(1).max(MAX_TEXT_LENGTH))
    .max(MAX_EXPECTED_RETRIEVAL_IDS)
    .optional(),
  expectedEntities: z.array(expectedEntitySchema).max(MAX_EXPECTED_ENTITIES).optional(),
  expectedClaims: expectedClaimsSchema.optional(),
  expectedSteps: expectedStepsSchema.optional(),
  expectedTerminationReason: terminationReasonSchema.optional(),
  expectedRubric: z.array(z.string().min(1).max(MAX_TEXT_LENGTH))
    .max(MAX_RUBRIC_ITEMS)
    .optional(),
}).strict();

export type ScenarioAnnotation = z.infer<typeof scenarioAnnotationSchema>;
export type AnnotationConstraintAtom = z.infer<typeof constraintAtomSchema>;
export type AnnotationExpectedClaims = z.infer<typeof expectedClaimsSchema>;
export type AnnotationExpectedSteps = z.infer<typeof expectedStepsSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Parse helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse external JSON into a `ScenarioAnnotation`. Throws ZodError with the
 * exact field/path that failed — the annotate CLI relies on this for
 * actionable error messages.
 *
 * CLAUDE.md rule 12: never `JSON.parse(...) as T`. Caller passes unknown.
 */
export function parseScenarioAnnotation(input: unknown): ScenarioAnnotation {
  return scenarioAnnotationSchema.parse(input);
}

/**
 * Convert an annotation's `expectedConstraints` block into the in-source
 * `ScenarioExpectation['expectedConstraints']` shape so the scorer can
 * consume it without a parallel path. Annotations are the authoritative
 * source — they OVERRIDE any inline `expectedConstraints` on the scenario.
 */
export function annotationConstraintsToExpectation(
  c: NonNullable<ScenarioAnnotation['expectedConstraints']>,
): { hard?: readonly ExpectedConstraint[]; soft?: readonly ExpectedConstraint[]; inferred?: readonly ExpectedConstraint[] } {
  const cast = (atoms: readonly AnnotationConstraintAtom[] | undefined): readonly ExpectedConstraint[] | undefined => {
    if (atoms === undefined) return undefined;
    return atoms.map((a) => ({
      attribute: a.attribute,
      operator: a.operator,
      value: a.value as ExpectedConstraint['value'],
    }));
  };
  return {
    ...(cast(c.hard) !== undefined ? { hard: cast(c.hard)! } : {}),
    ...(cast(c.soft) !== undefined ? { soft: cast(c.soft)! } : {}),
    ...(cast(c.inferred) !== undefined ? { inferred: cast(c.inferred)! } : {}),
  };
}

/**
 * Convert annotation entities into the in-source `ExpectedEntity[]` shape.
 */
export function annotationEntitiesToExpectation(
  entities: NonNullable<ScenarioAnnotation['expectedEntities']>,
): readonly ExpectedEntity[] {
  return entities.map((e) => ({
    surface: e.surface,
    canonical: e.canonical,
    type: e.type,
  }));
}
