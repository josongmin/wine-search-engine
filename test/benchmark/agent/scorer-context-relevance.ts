/**
 * Context-relevance scoring (RAGAS-style).
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 8.5).
 *
 * Public surface:
 *   - `scoreContextRelevance` — the dim scorer wired into scoreScenario.
 *   - `scoreExactLookupContextRelevance` — `exact_entity` recall variant.
 *   - `parseToolCallInput` — re-used by `scorer.ts` (isSearchWinesPartitionBatch).
 *
 * The 7 internal helpers (`evidenceTextIncludes`, `evidenceNumericValues`,
 * `collectStyleHintsFromToolInput`, `collectStructuredToolContextRelevanceChecks`,
 * `expectedEntityEvidenceFields`, `collectExpectedEntityContextRelevanceChecks`,
 * `formatContextCheckSummary`, `summarizeContextAxisChecks`,
 * `parseDrinkingWindowFromObs`) and the two internal types
 * (`ContextRelevanceAxis`, `ContextRelevanceCheck`) stay module-private — they
 * have no external consumers and the API surface is intentionally narrow.
 */

import type {
  AgentBenchmarkScenario,
  ScenarioExpectation,
} from './scenario.js';
import type { EvidenceRecord } from '../../../src/domain/evaluation/service/claim-level-evaluator.js';
import type {
  Diagnostic,
  DiagnosticSeverity,
  ScenarioExecution,
  ToolCallTrace,
} from './scorer.js';
import {
  isHonestNoEvidenceAbstentionScenario,
  normalizeObservations,
} from './scorer-abstention.js';
import {
  CTX_COUNTRY_MAP,
  CTX_REGION_MAP,
  CTX_WINE_TYPE_MAP,
} from './scorer-ctx-maps.js';
import {
  buildContextEvidenceRecords,
  normalizeEvidenceText,
} from './scorer-evidence-utils.js';
import {
  buildExactLookupNeedles,
  collectObservedExactLookupValues,
  formatObservedExactLookupSummary,
  observedCanonicalIncludesNeedle,
} from './scorer-exact-lookup-utils.js';
import {
  extractKoreanPrices,
  extractVintageYears,
} from './scorer-text-extractors.js';

type ContextRelevanceAxis = 'raw_alignment' | 'structured';

type ContextRelevanceCheck = {
  readonly passed: boolean;
  readonly label: string;
  readonly axis: ContextRelevanceAxis;
  readonly hard?: boolean | undefined;
};

/** Fixed reference year for deterministic benchmark scoring of drink windows. */
const BENCHMARK_REFERENCE_YEAR = 2026;

/**
 * Sweetness numeric thresholds for the `style` hint checks. The bench's
 * canonical `sweetness` field is normalized to [0, 1]; these bounds line up
 * with the style→sweetness contract used by the search planner.
 */
const SWEET_MIN_SWEETNESS = 0.5;
const OFF_DRY_MIN_SWEETNESS = 0.2;
const OFF_DRY_MAX_SWEETNESS = 0.6;
const DRY_MAX_SWEETNESS = 0.2;

/**
 * JSON-parse a tool call's input string into a plain object. Returns `null` for
 * empty input, primitive / array payloads, or invalid JSON. Used by the scorer
 * top-level (isSearchWinesPartitionBatch) AND by structured-tool context checks.
 */
export function parseToolCallInput(call: ToolCallTrace): Record<string, unknown> | null {
  if (typeof call.input !== 'string' || call.input.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(call.input) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function evidenceTextIncludes(
  records: readonly EvidenceRecord[],
  fields: readonly string[],
  expected: string,
): boolean {
  const needle = normalizeEvidenceText(expected);
  if (needle.length === 0) return false;
  return records.some((record) =>
    fields.some((field) => {
      const value = record[field];
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) {
        return value.some((entry) => normalizeEvidenceText(entry).includes(needle));
      }
      return normalizeEvidenceText(value).includes(needle);
    }),
  );
}

function evidenceNumericValues(
  records: readonly EvidenceRecord[],
  field: string,
): readonly number[] {
  return records
    .map((record) => record[field])
    .flatMap((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return [value];
      if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? [parsed] : [];
      }
      return [];
    });
}

function collectStyleHintsFromToolInput(input: Record<string, unknown>): readonly string[] {
  const styles = input['styles'];
  if (Array.isArray(styles)) {
    return styles.filter((style): style is string => typeof style === 'string');
  }
  const style = input['style'];
  return typeof style === 'string' ? [style] : [];
}

function collectStructuredToolContextRelevanceChecks(
  execution: ScenarioExecution,
): readonly ContextRelevanceCheck[] {
  const records = buildContextEvidenceRecords(execution);
  if (records.length === 0) return [];

  const checks: ContextRelevanceCheck[] = [];
  for (const call of execution.toolsUsed) {
    const input = parseToolCallInput(call);
    if (input === null) continue;

    const wineType = input['wine_type'];
    if (typeof wineType === 'string') {
      checks.push({
        passed: evidenceTextIncludes(records, ['wine_type', 'style'], wineType),
        label: `tool_wine_type_${wineType}`,
        axis: 'structured',
      });
    }

    const country = input['country'];
    if (typeof country === 'string') {
      checks.push({
        passed: evidenceTextIncludes(records, ['country', 'region', 'appellation'], country),
        label: `tool_country_${country}`,
        axis: 'structured',
      });
    }

    const appellation = input['appellation'];
    if (typeof appellation === 'string') {
      checks.push({
        passed: evidenceTextIncludes(records, ['appellation', 'region'], appellation),
        label: `tool_appellation_${appellation}`,
        axis: 'structured',
      });
    }

    const maxAlcoholPct = input['max_alcohol_pct'];
    if (typeof maxAlcoholPct === 'number' && Number.isFinite(maxAlcoholPct)) {
      const alcoholValues = evidenceNumericValues(records, 'alcohol_pct');
      checks.push({
        passed: alcoholValues.some((value) => value <= maxAlcoholPct),
        label: `tool_alcohol_pct_lte_${maxAlcoholPct}`,
        axis: 'structured',
      });
    }

    for (const style of collectStyleHintsFromToolInput(input)) {
      const normalizedStyle = normalizeEvidenceText(style).replace(/_/gu, ' ');
      if (normalizedStyle === 'sweet') {
        const sweetnessValues = evidenceNumericValues(records, 'sweetness');
        checks.push({
          passed:
            evidenceTextIncludes(records, ['style', 'wine_type'], 'sweet')
            || evidenceTextIncludes(records, ['wine_type'], 'dessert')
            || sweetnessValues.some((value) => value >= SWEET_MIN_SWEETNESS),
          label: 'tool_style_sweet',
          axis: 'structured',
        });
        continue;
      }
      if (normalizedStyle === 'off dry') {
        const sweetnessValues = evidenceNumericValues(records, 'sweetness');
        checks.push({
          passed:
            evidenceTextIncludes(records, ['style'], 'off dry')
            || sweetnessValues.some((value) => value >= OFF_DRY_MIN_SWEETNESS && value <= OFF_DRY_MAX_SWEETNESS),
          label: 'tool_style_off_dry',
          axis: 'structured',
        });
        continue;
      }
      if (normalizedStyle === 'dry') {
        const sweetnessValues = evidenceNumericValues(records, 'sweetness');
        checks.push({
          passed:
            evidenceTextIncludes(records, ['style'], 'dry')
            || sweetnessValues.some((value) => value <= DRY_MAX_SWEETNESS),
          label: 'tool_style_dry',
          axis: 'structured',
        });
      }
    }
  }

  return checks;
}

function expectedEntityEvidenceFields(
  type: NonNullable<ScenarioExpectation['expectedEntities']>[number]['type'],
): readonly string[] {
  switch (type) {
    case 'wine_type':
      return ['wine_type', 'style', 'comparison_concept'];
    case 'country':
      return ['country', 'region', 'appellation', 'comparison_concept'];
    case 'region':
      return ['region', 'appellation', 'comparison_concept'];
    case 'appellation':
      return ['appellation', 'region', 'canonical_label', 'comparison_concept'];
    case 'grape_primary':
      return ['grapes', 'canonical_label', 'comparison_concept'];
  }
}

function collectExpectedEntityContextRelevanceChecks(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
): readonly ContextRelevanceCheck[] {
  if (exp.expectedEntities === undefined || exp.expectedEntities.length === 0) {
    return [];
  }
  const records = buildContextEvidenceRecords(execution);
  if (records.length === 0) return [];

  return exp.expectedEntities.map((entity) => ({
    passed: evidenceTextIncludes(records, expectedEntityEvidenceFields(entity.type), entity.canonical),
    label: `expected_entity_${entity.type}_${entity.canonical}`,
    axis: 'raw_alignment',
  }));
}

function formatContextCheckSummary(
  checks: readonly ContextRelevanceCheck[],
  failed: readonly string[],
): string {
  const passedCount = checks.length - failed.length;
  return `passed ${passedCount}/${checks.length}; failed=${failed.length > 0 ? failed.join(', ') : 'none'}`;
}

function summarizeContextAxisChecks(
  axis: ContextRelevanceAxis,
  checks: readonly ContextRelevanceCheck[],
): string {
  if (checks.length === 0) {
    return `${axis}=n/a`;
  }
  const failed = checks.filter((check) => !check.passed).map((check) => check.label);
  return `${axis} ${formatContextCheckSummary(checks, failed)}`;
}

function parseDrinkingWindowFromObs(
  obsText: string,
  expected: 'now' | 'hold' | 'past',
): boolean | null {
  // Strategy 1: exact status phrases from an explicit drinking-window result
  const STATUS_PHRASES: Record<string, RegExp> = {
    now: /currently drinkable/i,
    hold: /not yet at peak|hold until/i,
    past: /past peak/i,
  };
  const anyStatusFound = Object.values(STATUS_PHRASES).some((re) => re.test(obsText));
  if (anyStatusFound) {
    return STATUS_PHRASES[expected]!.test(obsText);
  }

  // Strategy 2: parse "drink: YYYY-YYYY" year range and infer status.
  // Use a fixed benchmark reference year so the same saved run scores the same
  // way next year; otherwise this metric drifts with wall-clock time.
  const drinkRangeRe = /\bdrink:\s*(\d{4})\s*[-–]\s*(\d{4})\b/gi;
  let match: RegExpExecArray | null;
  let foundAny = false;
  while ((match = drinkRangeRe.exec(obsText)) !== null) {
    foundAny = true;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const inferred = BENCHMARK_REFERENCE_YEAR < start ? 'hold' : BENCHMARK_REFERENCE_YEAR > end ? 'past' : 'now';
    if (inferred === expected) return true;
  }
  if (foundAny) return false; // ranges found but none matched expected status

  return null; // no drinking window data in observations
}

export function scoreExactLookupContextRelevance(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number | null {
  const exactLookup = exp.exactLookup;
  if (exactLookup === undefined || exactLookup.matchPolicy !== 'exact_entity') {
    return null;
  }

  const records = buildContextEvidenceRecords(execution);
  const observed = collectObservedExactLookupValues(records);
  const expectedNeedles = buildExactLookupNeedles(exactLookup);
  if (expectedNeedles.length === 0) {
    return null;
  }
  const collapseWhitespace = exactLookup.allowSpaceNormalization !== false;
  const canonicalHit = expectedNeedles.some((needle) =>
    observedCanonicalIncludesNeedle(observed.canonicalLabels, needle, collapseWhitespace),
  );
  const entityHit = exactLookup.expectedEntityId !== undefined
    && exactLookup.expectedEntityId !== null
    && observed.entityIds.includes(exactLookup.expectedEntityId);

  if (canonicalHit || entityHit) {
    return 1;
  }

  diagnostics.push({
    dim: 'contextRelevance',
    severity: 'warn',
    code: 'EXACT_LOOKUP_CONTEXT_RELEVANCE_LOW',
    message: 'exact lookup tool context did not contain the expected entity / canonical aliases',
    observed: formatObservedExactLookupSummary(observed),
    expected: expectedNeedles.join(' | '),
  });
  return 0;
}

export function scoreContextRelevance(
  scenario: AgentBenchmarkScenario,
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number | null {
  if (
    execution.observations.length === 0
    && (execution.evidenceFrames === undefined || execution.evidenceFrames.length === 0)
  ) {
    return null;
  }
  if (isHonestNoEvidenceAbstentionScenario(exp, execution)) {
    diagnostics.push({
      dim: 'contextRelevance',
      severity: 'info',
      code: 'CONTEXT_RELEVANCE_SKIPPED_NO_EVIDENCE_ABSTENTION',
      message: 'context relevance not scored: scenario explicitly allows honest abstention when retrieval returned no confirmable evidence',
    });
    return null;
  }
  if (
    exp.exactLookup?.matchPolicy === 'must_not_exact_match'
    || exp.exactLookup?.matchPolicy === 'must_not_return_guarded_entity'
  ) {
    diagnostics.push({
      dim: 'contextRelevance',
      severity: 'info',
      code: 'CONTEXT_RELEVANCE_SKIPPED_FAIL_CLOSED_EXACT_LOOKUP',
      message: 'context relevance not scored: fail-closed exact lookup scenarios are evaluated by exactLookup/failClosedAccuracy',
    });
    return null;
  }
  const exactLookupRelevance = scoreExactLookupContextRelevance(exp, execution, diagnostics);
  if (exactLookupRelevance !== null) {
    return exactLookupRelevance;
  }
  // normalizeObservations() is the single source of truth for joining.
  // Note: scoreContextRelevance uses the un-lowercased form for regex matching below,
  // so we call join directly here but with the canonical '\n' separator.
  const obsText = execution.observations.join('\n');

  const checks: ContextRelevanceCheck[] = [];

  // Price check: any prices mentioned in observations should be in range
  if (exp.priceBandKrw !== undefined) {
    const prices = extractKoreanPrices(obsText);
    if (prices.length > 0) {
      const inRange = prices.filter((p) => {
        if (exp.priceBandKrw!.min !== undefined && p < exp.priceBandKrw!.min) return false;
        if (exp.priceBandKrw!.max !== undefined && p > exp.priceBandKrw!.max) return false;
        return true;
      });
      checks.push({ passed: inRange.length > 0, label: 'price_in_range', axis: 'structured' });
    }
  }

  // Vintage check
  if (exp.vintageRange !== undefined) {
    const years = extractVintageYears(obsText);
    if (years.length > 0) {
      const inRange = years.filter((y) => {
        if (exp.vintageRange!.min !== undefined && y < exp.vintageRange!.min) return false;
        if (exp.vintageRange!.max !== undefined && y > exp.vintageRange!.max) return false;
        return true;
      });
      checks.push({
        passed: inRange.length > 0,
        label: 'vintage_in_range',
        axis: 'structured',
        hard: true,
      });
    }
  }

  // Drinking window status check — v4: structured parsing replaces keyword heuristic.
  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any') {
    const dwResult = parseDrinkingWindowFromObs(obsText, exp.drinkingWindowStatus);
    if (dwResult !== null) {
      checks.push({
        passed: dwResult,
        label: `dw_status_${exp.drinkingWindowStatus}`,
        axis: 'structured',
      });
    }
  }

  // Cross-domain checks: wine_type, country, region.
  const queryNfkc = scenario.query.toLowerCase().normalize('NFKC');
  const obsNfkc = normalizeObservations(execution.observations);

  for (const [korean, english] of CTX_WINE_TYPE_MAP) {
    if (queryNfkc.includes(korean)) {
      checks.push({
        passed: obsNfkc.includes(english),
        label: `wine_type_${english}`,
        axis: 'raw_alignment',
      });
      break;
    }
  }

  for (const [pattern, canonical] of CTX_COUNTRY_MAP) {
    if (pattern.test(queryNfkc)) {
      checks.push({
        passed: obsNfkc.includes(canonical.toLowerCase()),
        label: `country_${canonical}`,
        axis: 'raw_alignment',
      });
      break;
    }
  }

  for (const [korean, english] of CTX_REGION_MAP) {
    if (queryNfkc.includes(korean)) {
      checks.push({
        passed: obsNfkc.includes(english),
        label: `region_${english}`,
        axis: 'raw_alignment',
      });
      break;
    }
  }

  // RFC-020: expectedConstraints-based checks.
  if (exp.expectedConstraints?.hard) {
    for (const constraint of exp.expectedConstraints.hard) {
      if (typeof constraint.value !== 'string') continue;
      const valueLower = constraint.value.normalize('NFKC').toLowerCase();
      if (constraint.attribute === 'wine_type' || constraint.attribute === 'country' || constraint.attribute === 'region' || constraint.attribute === 'appellation') {
        checks.push({
          passed: obsNfkc.includes(valueLower),
          label: `${constraint.attribute}_constraint_${constraint.value}`,
          axis: 'structured',
        });
      }
    }
  }

  const structuredToolChecks = collectStructuredToolContextRelevanceChecks(execution);
  checks.push(...structuredToolChecks);
  checks.push(...collectExpectedEntityContextRelevanceChecks(exp, execution));

  if (checks.length === 0) return null; // no constraints to evaluate

  // P1-B: hard constraints fail-closed; non-hard checks partitioned by axis.
  const hardFailed = checks
    .filter((check) => check.hard === true && !check.passed)
    .map((check) => check.label);
  const rawAlignmentChecks = checks.filter((check) => check.axis === 'raw_alignment');
  const structuredChecks = checks.filter((check) => check.axis === 'structured' && check.hard !== true);
  const axisScores = [
    rawAlignmentChecks.length > 0
      ? rawAlignmentChecks.filter((check) => check.passed).length / rawAlignmentChecks.length
      : null,
    structuredChecks.length > 0
      ? structuredChecks.filter((check) => check.passed).length / structuredChecks.length
      : null,
  ].filter((value): value is number => value !== null);

  const failed = checks.filter((check) => !check.passed).map((check) => check.label);
  const score = hardFailed.length > 0
    ? 0
    : axisScores.length > 0
      ? axisScores.reduce((sum, value) => sum + value, 0) / axisScores.length
      : 1;

  if (score < 1) {
    const severity: DiagnosticSeverity = hardFailed.length > 0 ? 'critical' : 'warn';
    const checkSummary = [
      summarizeContextAxisChecks('raw_alignment', rawAlignmentChecks),
      summarizeContextAxisChecks('structured', structuredChecks),
      `hard_failed=${hardFailed.length > 0 ? hardFailed.join(', ') : 'none'}`,
      `failed=${failed.length > 0 ? failed.join(', ') : 'none'}`,
    ].join('; ');
    diagnostics.push({
      dim: 'contextRelevance',
      severity,
      code: hardFailed.length > 0 ? 'CONTEXT_HARD_CONSTRAINT_FAILED' : 'CONTEXT_RELEVANCE_LOW',
      message: hardFailed.length > 0
        ? `hard constraint(s) failed — retrieval returned out-of-range results: ${hardFailed.join(', ')} (${checkSummary})`
        : `tool results did not match constraints (${checkSummary})`,
      observed: score,
      expected: 1,
    });
  }

  return score;
}
