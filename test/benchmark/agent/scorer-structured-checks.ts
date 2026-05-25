/**
 * Structured assertion checks (price band, vintage, tool args, citations).
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 * Returns a multiplier in (0, 1] applied to answerQuality.
 */

import type { ScenarioExpectation } from './scenario.js';
import type { Diagnostic, ScenarioExecution } from './scorer.js';
import { normalizeObservations } from './scorer-abstention.js';
import {
  evaluatePredicate,
  formatToolArgValue,
  getNestedValue,
} from './scorer-predicate-eval.js';
import {
  extractKoreanPrices,
  extractProperNouns,
  extractVintageYears,
} from './scorer-text-extractors.js';

/** Structured check: price outside scenario band → 30% dock. */
const PENALTY_PRICE_BAND_VIOLATED = 0.7;
/** Structured check: vintage year outside range → 30% dock. */
const PENALTY_VINTAGE_RANGE_VIOLATED = 0.7;
/** Structured check: drinking-window keywords missing → 20% dock. */
const PENALTY_DRINKING_WINDOW_MISMATCH = 0.8;
/** Tool called but required arg predicate unsatisfied → 30% dock (v4 aligned). */
const PENALTY_TOOL_ARG_MISSING = 0.7;
/** Wine names in answer not grounded in tool observations → 50% dock. */
const PENALTY_UNCITED_WINE_NAMES = 0.5;

export function scoreStructuredChecks(
  exp: ScenarioExpectation,
  answer: string,
  execution: ScenarioExecution,
  diagnostics: Diagnostic[],
  judgeScore?: number,
): number {
  let multiplier = 1;
  // When the LLM was unavailable (step-0 fallback), the fallback answer embeds the
  // user's query text verbatim. Register and drinkingWindow checks on that text would
  // score the USER's language, not the AGENT's. Skip those dims to avoid false positives.
  const isStep0Fallback = execution.terminationReason === 'fallback' && (execution.stepCount ?? 0) === 0;

  // 1. priceBandKrw — extract Korean price patterns, check bounds
  if (exp.priceBandKrw !== undefined) {
    const prices = extractKoreanPrices(answer);
    if (prices.length > 0) {
      const outOfBound = prices.filter((p) => {
        if (exp.priceBandKrw!.min !== undefined && p < exp.priceBandKrw!.min) return true;
        if (exp.priceBandKrw!.max !== undefined && p > exp.priceBandKrw!.max) return true;
        return false;
      });
      if (outOfBound.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'PRICE_BAND_VIOLATED',
          message: `prices out of range: ${outOfBound.join(', ')} KRW`,
          observed: outOfBound.join(','),
          expected: `${exp.priceBandKrw.min ?? '?'}-${exp.priceBandKrw.max ?? '?'}`,
        });
        multiplier *= PENALTY_PRICE_BAND_VIOLATED;
      }
    }
  }

  // 2. vintageRange — extract 4-digit years, check min/max
  if (exp.vintageRange !== undefined) {
    const years = extractVintageYears(answer);
    if (years.length > 0) {
      const outOfRange = years.filter((y) => {
        if (exp.vintageRange!.min !== undefined && y < exp.vintageRange!.min) return true;
        if (exp.vintageRange!.max !== undefined && y > exp.vintageRange!.max) return true;
        return false;
      });
      if (outOfRange.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'VINTAGE_RANGE_VIOLATED',
          message: `vintages out of range: ${outOfRange.join(', ')}`,
          observed: outOfRange.join(','),
          expected: `${exp.vintageRange.min ?? '?'}-${exp.vintageRange.max ?? '?'}`,
        });
        multiplier *= PENALTY_VINTAGE_RANGE_VIOLATED;
      }
    }
  }

  // 3. drinkingWindowStatus — keyword match
  // Skip for step-0 fallback: the fallback answer embeds the user's query text, which may
  // accidentally contain cellar/hold keywords from the query itself — not from the agent.
  if (exp.drinkingWindowStatus !== undefined && exp.drinkingWindowStatus !== 'any' && !isStep0Fallback) {
    const status = exp.drinkingWindowStatus;
    const keywords: Record<string, readonly RegExp[]> = {
      now: [/drinkable|peak|optimal|currently|지금|마시기\s*좋|음용\s*적기|최적|피크/iu],
      hold: [/hold|cellar|aging|young|숙성|보관|셀러|셀러링|더\s*기다|음용\s*전|아직|이르/iu],
      past: [/past|over|decline|지남|지났|과거/iu],
    };
    const patterns = keywords[status] ?? [];
    const found = patterns.some((re) => re.test(answer));
    if (!found) {
      diagnostics.push({
        dim: 'answerQuality',
        severity: 'warn',
        code: 'DRINKING_WINDOW_MISMATCH',
        message: `expected drinking window status '${status}' keywords not found`,
        expected: status,
      });
      multiplier *= PENALTY_DRINKING_WINDOW_MISMATCH;
    }
  }

  // 4. expectedToolArgs — tool input JSON dot-path traversal
  if (exp.expectedToolArgs !== undefined && exp.expectedToolArgs.length > 0) {
    for (const argSpec of exp.expectedToolArgs) {
      const matchingCalls = execution.toolsUsed.filter((t) => t.tool === argSpec.tool);
      const observedValues: string[] = [];
      const anyMatch = matchingCalls.some((call) => {
        try {
          const parsed = (JSON.parse(call.input ?? '{}') as unknown) as Record<string, unknown>;
          const value = getNestedValue(parsed, argSpec.argPath);
          observedValues.push(formatToolArgValue(value));
          return evaluatePredicate(value, argSpec.predicate, argSpec.value);
        } catch {
          diagnostics.push({
            dim: 'toolAccuracy',
            severity: 'warn',
            code: 'TOOL_ARG_PARSE_FAILED',
            message: 'Failed to parse tool input JSON for expectedToolArgs check',
          });
          return false;
        }
      });
      if (!anyMatch) {
        diagnostics.push({
          dim: 'toolAccuracy',
          severity: 'warn',
          code: 'EXPECTED_TOOL_ARG_MISSING',
          message: `${argSpec.tool}.${argSpec.argPath} ${argSpec.predicate} ${argSpec.value === undefined ? '' : JSON.stringify(argSpec.value)} not satisfied across ${matchingCalls.length} matching tool call(s)`,
          observed: observedValues.length > 0 ? observedValues.join(' | ') : '<no matching tool calls>',
          expected: `${argSpec.predicate} ${argSpec.value === undefined ? '' : JSON.stringify(argSpec.value)}`.trim(),
        });
        multiplier *= PENALTY_TOOL_ARG_MISSING;
      }
    }
  }

  // 5/6/7: requireHedging / requiredRegister / maxConfidence
  //
  // v4 STRUCTURAL FIX: removed regex-based heuristic checks for these three
  // semantic dimensions. They are now evaluated EXCLUSIVELY by the LLM judge
  // via composeAutoRubric (judge.ts), which generates rubric criteria from
  // these scenario fields and lets the judge evaluate semantically.
  //
  // Why removed (the heuristic-tightening trap):
  // - hedging regex /아마도|어쩌면|.../ — Korean hedging is context-dependent;
  //   formal sommelier writing can hedge without these tokens, casual chat can
  //   use them in non-hedging contexts. Pattern enumeration is endless.
  // - register markers (formal=합니다/습니다, casual=줄게/건데/잖아...) — Korean
  //   register is a morphosyntactic property, not a token bag count. Elliptical
  //   formal writing has no markers; mixed-register text isn't binary.
  // - overconfident regex /틀림없이|무조건|.../ — overconfidence is pragmatic
  //   stance, not vocabulary. "확실히 좋은 와인" was a known false positive; the
  //   real fix isn't enumerating safe vs unsafe words, it's semantic judgment.
  //
  // The judge already evaluates these scenarios (composeAutoRubric emits
  // bilingual rubric criteria for each). Removing the regex layer eliminates
  // false positives AND the heuristic-tightening cycle (every new edge case
  // required another regex tweak). For these three dims, the judge IS the
  // evaluator — not an offset to a heuristic.
  //
  // Note: scenarios with these fields SHOULD have judgeRequired:true to ensure
  // the judge runs. The NO_QUALITY_CONSTRAINTS diagnostic surfaces gaps.
  //
  // PENALTY_HEDGING_MISSING, PENALTY_REGISTER_MISMATCH, PENALTY_OVERCONFIDENT
  // constants removed (no callers).

  // 8. refusalExpected — CRITICAL: answer must contain refusal + must NOT contain affirmation
  if (exp.refusalExpected === true) {
    // v4 STRUCTURAL FIX: regex-based refusal detection removed. Replaced with
    // judge-driven semantic evaluation via composeAutoRubric.
    //
    // Old regex (removed): /존재하지|찾을 수 없|.../ for refusal markers and
    // /재고 있|구매 가능|.../ for affirmative markers. Both produced false positives:
    //
    // - '맛없는' (tasteless), '타닌이 없고' (low tannin), '오크 없는' (unoaked) all
    //   match '없' as a wine descriptor, not a refusal. The previous fix was to
    //   tighten patterns ('없습니다'/'없어요') but Korean wine vocabulary will keep
    //   producing edge cases (없는, 없이, 없네, ...).
    // - '추천(?:해|합니다|드립니다)' matches "I recommend you NOT buy this" — the
    //   regex sees affirmation in a refusal context.
    // - 'available' vs 'unavailable' negative lookbehind solved one case but not
    //   'nonavailable', 'unavailably', etc.
    //
    // The judge already evaluates refusal scenarios via composeAutoRubric:
    //   "The answer must refuse or indicate that the requested item does not
    //    exist. Must NOT fabricate availability or details."
    //
    // For these scenarios, the judge IS the evaluator. The only remaining
    // fail-safe is the empty-answer check at the top of scoreAnswerQuality
    // (which already returns 0 with EMPTY_ANSWER critical diagnostic).
    //
    // Scenarios with refusalExpected:true SHOULD have judgeRequired:true.
    // Without judge, this dimension produces no signal — but that's honest
    // (we can't reliably detect refusal via regex).
    if (judgeScore === undefined) {
      diagnostics.push({
        dim: 'judge',
        severity: 'warn',
        code: 'REFUSAL_NO_JUDGE_SIGNAL',
        message: 'refusalExpected=true but judge is disabled — no signal to verify refusal',
      });
    }
  }

  // 9. mustCiteFromToolResults — wine names in answer must appear in observations
  if (exp.mustCiteFromToolResults === true && execution.observations.length > 0) {
    // Extract wine-like proper nouns from the answer (capitalized multi-word sequences)
    const answerWineNames = extractProperNouns(answer);
    if (answerWineNames.length > 0) {
      const observationText = normalizeObservations(execution.observations);
      // v4 fix: NFKC-normalize extracted names before comparison. extractProperNouns
      // returns raw text (possibly NFD from copy-paste), but normalizeObservations uses
      // NFKC. Without this, "Château" in NFD won't match "Château" in NFKC → false
      // UNCITED_WINE_NAMES penalty on correctly-cited accented wine names.
      const uncited = answerWineNames.filter(
        (name) => !observationText.includes(name.toLowerCase().normalize('NFKC')),
      );
      if (uncited.length > 0) {
        diagnostics.push({
          dim: 'answerQuality',
          severity: 'warn',
          code: 'UNCITED_WINE_NAMES',
          message: `wine names in answer not found in tool results: ${uncited.join(', ')}`,
          observed: uncited.join(','),
        });
        multiplier *= PENALTY_UNCITED_WINE_NAMES;
      }
    }
  }

  return multiplier;
}
