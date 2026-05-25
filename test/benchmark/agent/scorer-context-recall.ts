/**
 * Context-recall scoring (RAGAS-style).
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 8.4).
 *
 * Three exported helpers + one orchestrator:
 *   - `scoreContextRecall` — public entry point. Honest-abstention-aware,
 *     prefers `scenario.goldenKeywords`, falls back to keywords auto-inferred
 *     from `answerMustMatch` regex alternations, and degenerately defers to
 *     `scoreExactLookupContextRecall` when nothing else is available.
 *   - `scoreExactLookupContextRecall` — fraction-of-expected-entity surface
 *     recall for `exact_entity` exact-lookup scenarios.
 *   - `inferGoldenKeywordsFromExpectation` — regex-alternation → keyword set
 *     so scenarios without hand-curated keywords still produce a meaningful
 *     recall metric (without this fallback, coverage sits at ~6%).
 *
 * Pure functions — no I/O, no shared state. Diagnostics are appended into the
 * caller-supplied array.
 */

import type {
  AgentBenchmarkScenario,
  ScenarioExpectation,
} from './scenario.js';
import type { Diagnostic, ScenarioExecution } from './scorer.js';
import {
  isHonestNoEvidenceAbstentionScenario,
  normalizeObservations,
} from './scorer-abstention.js';
import { buildContextEvidenceRecords } from './scorer-evidence-utils.js';
import {
  buildExactLookupNeedles,
  collectObservedExactLookupValues,
  formatObservedExactLookupSummary,
  observedCanonicalIncludesNeedle,
} from './scorer-exact-lookup-utils.js';

/**
 * High-frequency wine-domain tokens that match too many observations to carry
 * recall signal — dropped from auto-inferred keyword sets so they don't inflate
 * scores. Module-scope per CLAUDE.md rule 16.
 */
const GENERIC_RECALL_TOKENS: ReadonlySet<string> = new Set<string>([
  'wine', '와인', 'red', '레드', 'white', '화이트', 'recommend', 'recommendation',
  'pairing', 'good', 'nice', 'party', 'gift', 'day', '추천', '좋은',
]);

/**
 * Minimum cleaned-token length kept when inferring keywords from regex
 * alternations. Two-character fragments ("a", "is", "이") are too short to
 * carry recall signal and almost always match by accident.
 */
const MIN_INFERRED_KEYWORD_LENGTH = 3;

export function inferGoldenKeywordsFromExpectation(
  exp: ScenarioExpectation,
): readonly string[] | undefined {
  const patterns = exp.answerMustMatch;
  if (patterns === undefined || patterns.length === 0) return undefined;

  const keywords = new Set<string>();
  for (const pattern of patterns) {
    // Extract alternation groups: "(a|b|c)" → ["a", "b", "c"]
    const groupMatches = pattern.matchAll(/\(([^)]+)\)/g);
    for (const match of groupMatches) {
      const group = match[1];
      if (group === undefined) continue;
      for (const alt of group.split('|')) {
        // Strip common regex metacharacters and whitespace escapes.
        const cleaned = alt
          .replace(/\\s\*?/g, ' ')
          .replace(/\\[dDwWsS]/g, '')
          .replace(/[\\^$*+?.(){}[\]]/g, '')
          .trim()
          .toLowerCase();
        if (cleaned.length >= MIN_INFERRED_KEYWORD_LENGTH && !GENERIC_RECALL_TOKENS.has(cleaned)) {
          keywords.add(cleaned);
        }
      }
    }
  }

  return keywords.size > 0 ? [...keywords] : undefined;
}

export function scoreExactLookupContextRecall(
  exp: ScenarioExpectation,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number | null {
  const exactLookup = exp.exactLookup;
  if (exactLookup === undefined || exactLookup.matchPolicy !== 'exact_entity') {
    return null;
  }
  if (execution.observations.length === 0) {
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
    dim: 'contextRecall',
    severity: 'warn',
    code: 'EXACT_LOOKUP_CONTEXT_RECALL_LOW',
    message: 'exact lookup expected entity / canonical aliases were missing from observations',
    observed: formatObservedExactLookupSummary(observed),
    expected: expectedNeedles.join(' | '),
  });
  return 0;
}

export function scoreContextRecall(
  scenario: AgentBenchmarkScenario,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
): number | null {
  if (isHonestNoEvidenceAbstentionScenario(scenario.expectation, execution)) {
    diagnostics.push({
      dim: 'contextRecall',
      severity: 'info',
      code: 'CONTEXT_RECALL_SKIPPED_NO_EVIDENCE_ABSTENTION',
      message: 'context recall not scored: scenario explicitly allows honest abstention when retrieval returned no confirmable evidence',
    });
    return null;
  }
  // Explicit goldenKeywords take precedence. If absent, attempt auto-inference
  // from answerMustMatch regex groups (e.g. "(바롤로|barolo)" → ["barolo"]) so
  // scenarios without hand-curated keywords still get measured — context recall
  // coverage otherwise sits at 6.3% (6/95 scenarios), making the metric useless.
  const explicitGolden = scenario.goldenKeywords;
  const inferredGolden = explicitGolden === undefined || explicitGolden.length === 0
    ? inferGoldenKeywordsFromExpectation(scenario.expectation)
    : undefined;
  const effectiveGolden = explicitGolden && explicitGolden.length > 0
    ? explicitGolden
    : inferredGolden;

  if (effectiveGolden === undefined || effectiveGolden.length === 0) {
    return scoreExactLookupContextRecall(scenario.expectation, execution, diagnostics);
  }
  if (execution.observations.length === 0) return null;

  const exactLookupContextRecall = scoreExactLookupContextRecall(
    scenario.expectation,
    execution,
    diagnostics,
  );
  if (exactLookupContextRecall !== null) {
    return exactLookupContextRecall;
  }

  const obsLower = normalizeObservations(execution.observations);
  // Filter out empty strings — "".includes("") === true in JS, which would give
  // a free +1 hit to every recall score regardless of what the agent retrieved.
  // De-duplicate keywords: duplicate entries would inflate recall by counting
  // the same keyword multiple times. e.g. ["opus","opus","ridge"] with "opus"
  // in obs would score 2/3 instead of 1/2 (actual recall).
  const goldenRaw = effectiveGolden.filter((kw) => kw.trim().length > 0);
  const golden = [...new Set(goldenRaw.map((kw) => kw.toLowerCase().normalize('NFKC')))];
  if (golden.length === 0) return null;
  let hitCount = 0;
  for (const kw of golden) {
    if (obsLower.includes(kw)) {
      hitCount++;
    }
  }
  const score = hitCount / golden.length;

  if (score < 1) {
    const missing = golden.filter((kw) => !obsLower.includes(kw));
    diagnostics.push({
      dim: 'contextRecall',
      severity: 'warn',
      code: 'CONTEXT_RECALL_LOW',
      message: `golden keywords missing from observations: ${missing.join(', ')}`,
      observed: score,
      expected: 1,
    });
  }

  return score;
}
