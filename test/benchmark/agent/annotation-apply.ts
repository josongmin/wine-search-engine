/**
 * Apply a `ScenarioAnnotation` to a benchmark scenario + scored result.
 *
 * Two responsibilities:
 *   1. PRE-scoring: merge annotation into `ScenarioExpectation` so the scorer
 *      sees ground-truth `expectedConstraints` / `expectedEntities` /
 *      `answerContains` / `answerExcludes` / rubric WITHOUT every annotated
 *      dimension having to be duplicated in scenarios.*.ts.
 *   2. POST-scoring: enforce dimensions the scorer doesn't natively cover
 *      (`expectedRetrievalIds`, `expectedSteps`, `expectedTerminationReason`)
 *      by surfacing diagnostics. Done AFTER scoring so we keep `scoreScenario`
 *      pure and uncoupled from annotation IO.
 *
 * Both functions are pure (no IO) — the runner glues them around its existing
 * scoring loop.
 */

import type {
  AgentBenchmarkScenario,
  ScenarioExpectation,
} from './scenario.js';
import type {
  Diagnostic,
  DiagnosticSeverity,
  ScenarioExecution,
  ScenarioResult,
} from './scorer.js';
import {
  annotationConstraintsToExpectation,
  annotationEntitiesToExpectation,
  type ScenarioAnnotation,
} from './annotation-schema.js';

// ─── named constants (CLAUDE.md rule 15) ──────────────────────────────────
const MUST_NOT_MENTION_CRITICAL = true;
/** Max number of offending strings to surface in a diagnostic `observed` field. */
const DIAGNOSTIC_OBSERVED_MAX_ITEMS = 3;

/**
 * Per-dimension flags exposing whether the annotation drove that dimension.
 * Surfaced on each ScenarioResult so the bench summary can count
 * "annotated vs judge-only" without re-deriving from the annotation map.
 */
interface AnnotationApplied {
  readonly applied: boolean;
  readonly drives: {
    readonly constraints: boolean;
    readonly entities: boolean;
    readonly answerClaims: boolean;
    readonly steps: boolean;
    readonly termination: boolean;
    readonly retrievalIds: boolean;
    readonly rubric: boolean;
  };
}

const NONE_APPLIED: AnnotationApplied = {
  applied: false,
  drives: {
    constraints: false,
    entities: false,
    answerClaims: false,
    steps: false,
    termination: false,
    retrievalIds: false,
    rubric: false,
  },
};

/**
 * Merge an annotation into a scenario by layering its fields on top of the
 * inline `expectation`. Annotation always wins where both define a value —
 * annotations are the curated ground truth, scenarios.*.ts are seed sketches.
 *
 * Returns the unchanged scenario when no annotation is present so the bench
 * stays no-cost on unannotated scenarios.
 */
export function mergeAnnotationIntoScenario(
  scenario: AgentBenchmarkScenario,
  annotation: ScenarioAnnotation | undefined,
): { scenario: AgentBenchmarkScenario; applied: AnnotationApplied } {
  if (annotation === undefined) {
    return { scenario, applied: NONE_APPLIED };
  }

  const exp: ScenarioExpectation = { ...scenario.expectation };

  const drives = {
    constraints: false,
    entities: false,
    answerClaims: false,
    steps: false,
    termination: false,
    retrievalIds: false,
    rubric: false,
  };

  if (annotation.expectedConstraints !== undefined) {
    const merged = annotationConstraintsToExpectation(annotation.expectedConstraints);
    (exp as Mutable<ScenarioExpectation>).expectedConstraints = merged;
    drives.constraints = true;
  }
  if (annotation.expectedEntities !== undefined && annotation.expectedEntities.length > 0) {
    (exp as Mutable<ScenarioExpectation>).expectedEntities = annotationEntitiesToExpectation(
      annotation.expectedEntities,
    );
    drives.entities = true;
  }
  // answerClaims: append (don't replace) so an inline answerContains carries
  // forward and the annotator adds new ground truth on top.
  if (annotation.expectedClaims !== undefined) {
    const mustMention = annotation.expectedClaims.mustMention;
    const mustNotMention = annotation.expectedClaims.mustNotMention;
    if (mustMention !== undefined && mustMention.length > 0) {
      const prior = exp.answerContains ?? [];
      (exp as Mutable<ScenarioExpectation>).answerContains = dedupe([
        ...prior,
        ...mustMention,
      ]);
      drives.answerClaims = true;
    }
    if (mustNotMention !== undefined && mustNotMention.length > 0) {
      const prior = exp.answerExcludes ?? [];
      (exp as Mutable<ScenarioExpectation>).answerExcludes = dedupe([
        ...prior,
        ...mustNotMention,
      ]);
      drives.answerClaims = true;
    }
  }
  if (annotation.expectedTerminationReason !== undefined) {
    (exp as Mutable<ScenarioExpectation>).terminationReason = annotation.expectedTerminationReason;
    drives.termination = true;
  }
  // expectedRubric falls back into inline rubric ONLY when no inline rubric exists —
  // we don't want to silently overwrite a hand-tuned scenario rubric.
  if (
    annotation.expectedRubric !== undefined
    && annotation.expectedRubric.length > 0
    && exp.rubric === undefined
  ) {
    (exp as Mutable<ScenarioExpectation>).rubric = formatRubric(annotation.expectedRubric);
    drives.rubric = true;
  }

  // expectedSteps / expectedRetrievalIds are checked POST-scoring (no inline
  // analog), but we still flag them as driven by the annotation so the bench
  // summary annotated-count is accurate.
  if (annotation.expectedSteps !== undefined) drives.steps = true;
  if (annotation.expectedRetrievalIds !== undefined && annotation.expectedRetrievalIds.length > 0) {
    drives.retrievalIds = true;
  }

  return {
    scenario: { ...scenario, expectation: exp },
    applied: { applied: true, drives },
  };
}

/**
 * After `scoreScenario` runs, layer annotation-derived diagnostics that the
 * scorer didn't produce: step-count range, retrieval-id presence,
 * termination-reason mismatch (separate from the inline equality).
 *
 * Pure: returns a new `ScenarioResult` with merged diagnostics. The overall
 * score is NOT recomputed — the cost of re-running the geo-mean from here
 * isn't worth the small added signal; instead a `warn` diagnostic is enough
 * to flag regressions and surface in the worst-N triage block.
 */
export function applyAnnotationDiagnostics(
  scored: ScenarioResult,
  execution: ScenarioExecution | null,
  annotation: ScenarioAnnotation | undefined,
): ScenarioResult {
  if (annotation === undefined || execution === null) return scored;

  const extra: Diagnostic[] = [];

  if (annotation.expectedSteps !== undefined) {
    const observed = execution.stepCount;
    const { min, max } = annotation.expectedSteps;
    if (observed < min || observed > max) {
      extra.push(diagnostic({
        severity: 'warn',
        dim: 'stepEfficiency',
        code: 'annotation_steps_out_of_range',
        message: `Step count ${observed} outside annotation range [${min}, ${max}]`,
        observed: String(observed),
        expected: `${min}..${max}`,
      }));
    }
  }

  if (annotation.expectedRetrievalIds !== undefined && annotation.expectedRetrievalIds.length > 0) {
    const obsBlob = execution.observations.join(' \n ').toLowerCase().normalize('NFKC');
    const missing: string[] = [];
    for (const id of annotation.expectedRetrievalIds) {
      const needle = id.toLowerCase().normalize('NFKC');
      if (!obsBlob.includes(needle)) missing.push(id);
    }
    if (missing.length > 0) {
      extra.push(diagnostic({
        severity: 'warn',
        dim: 'contextRecall',
        code: 'annotation_retrieval_ids_missing',
        message: `${missing.length}/${annotation.expectedRetrievalIds.length} expected retrieval ids not seen in observations`,
        observed: 'absent',
        expected: missing.slice(0, DIAGNOSTIC_OBSERVED_MAX_ITEMS).join(','),
      }));
    }
  }

  if (annotation.expectedTerminationReason !== undefined) {
    if (scored.terminationReason !== annotation.expectedTerminationReason) {
      // Inline `terminationReason` already drives the scorer's terminationCorrectness
      // dimension when set; this extra diagnostic surfaces it as an annotation-attributable
      // signal even when the scenario inline did not specify a terminationReason.
      extra.push(diagnostic({
        severity: 'warn',
        dim: 'terminationCorrectness',
        code: 'annotation_termination_mismatch',
        message: `terminationReason ${String(scored.terminationReason)} != annotation ${annotation.expectedTerminationReason}`,
        observed: String(scored.terminationReason),
        expected: annotation.expectedTerminationReason,
      }));
    }
  }

  // mustNotMention violations are CRITICAL: a hand-curated forbidden mention
  // appearing in the answer is a hard quality regression.
  if (annotation.expectedClaims?.mustNotMention !== undefined && annotation.expectedClaims.mustNotMention.length > 0) {
    const answerBlob = (scored.answer ?? '').toLowerCase().normalize('NFKC');
    const hits: string[] = [];
    for (const forbidden of annotation.expectedClaims.mustNotMention) {
      const needle = forbidden.toLowerCase().normalize('NFKC');
      if (answerBlob.includes(needle)) hits.push(forbidden);
    }
    if (hits.length > 0) {
      extra.push(diagnostic({
        severity: MUST_NOT_MENTION_CRITICAL ? 'critical' : 'warn',
        dim: 'answerQuality',
        code: 'annotation_must_not_mention_violation',
        message: `${hits.length} forbidden mention(s) appeared in answer`,
        observed: hits.slice(0, DIAGNOSTIC_OBSERVED_MAX_ITEMS).join(','),
      }));
    }
  }

  if (extra.length === 0) return scored;

  return {
    ...scored,
    diagnostics: [...(scored.diagnostics ?? []), ...extra],
    diagnosticStrings: [
      ...(scored.diagnosticStrings ?? []),
      ...extra.map((d) => `${d.severity}: [${d.dim}] ${d.message}`),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function diagnostic(d: {
  severity: DiagnosticSeverity;
  dim: Diagnostic['dim'];
  code: string;
  message: string;
  observed?: string;
  expected?: string;
}): Diagnostic {
  return {
    severity: d.severity,
    dim: d.dim,
    code: d.code,
    message: d.message,
    ...(d.observed !== undefined ? { observed: d.observed } : {}),
    ...(d.expected !== undefined ? { expected: d.expected } : {}),
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase().normalize('NFKC');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function formatRubric(items: readonly string[]): string {
  return items.map((line, i) => `${i + 1}. ${line}`).join('\n');
}
