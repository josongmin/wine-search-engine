#!/usr/bin/env python3
"""Atomic scorer.ts round-9 decomposition. Usage: python3 scripts/split-scorer-r9.py <step>

Steps: predicate-eval | step-efficiency | tool-accuracy | answer-quality | structured-checks
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "test/benchmark/agent/scorer.ts"


def read_scorer() -> str:
    return SCORER.read_text(encoding="utf-8")


def write_scorer(text: str) -> None:
    SCORER.write_text(text, encoding="utf-8")


def write_module(name: str, content: str) -> None:
    path = ROOT / "test/benchmark/agent" / name
    path.write_text(content, encoding="utf-8")


def extract_block(src: str, start_marker: str, end_marker: str) -> tuple[str, str]:
    """Remove block between markers (inclusive start line through end line before end_marker)."""
    start = src.find(start_marker)
    if start == -1:
        raise ValueError(f"start marker not found: {start_marker!r}")
    end = src.find(end_marker, start)
    if end == -1:
        raise ValueError(f"end marker not found: {end_marker!r}")
    block = src[start:end]
    remainder = src[:start] + src[end:]
    return block, remainder


def insert_import_after_last_import(src: str, import_line: str) -> str:
    """Insert import after the last existing import from './scorer-*.js'."""
    pattern = re.compile(r"^import .+ from '\./scorer-.+\.js';$", re.MULTILINE)
    matches = list(pattern.finditer(src))
    if not matches:
        raise ValueError("no scorer-* imports found")
    pos = matches[-1].end()
    return src[:pos] + "\n" + import_line + src[pos:]


def step_predicate_eval() -> None:
    src = read_scorer()
    module = '''/**
 * Predicate evaluation for expectedToolArgs structured checks.
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (round 9.1).
 *
 * Public surface:
 *   - `evaluatePredicate` — dot-path predicate branches (unit-tested via scorer.ts re-export).
 *
 * `getNestedValue` / `formatToolArgValue` are module-internal helpers consumed by
 * {@link ./scorer-structured-checks.ts}.
 */

import { stableJsonStringify } from './scorer-tool-call-signatures.js';

/** Navigate a nested object by dot-path: "filters.priceMaxKrw" */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function formatToolArgValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return stableJsonStringify(value);
}

/** Evaluate a predicate against a value
 * @internal exported for direct unit testing of predicate branches. */
export function evaluatePredicate(
  actual: unknown,
  predicate: 'equals' | 'equals_any' | 'lte' | 'gte' | 'contains' | 'contains_any' | 'exists',
  expected?: unknown,
): boolean {
  switch (predicate) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === expected;
    case 'equals_any':
      return Array.isArray(expected) && expected.some((candidate) => actual === candidate);
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'contains':
      if (Array.isArray(actual)) {
        return actual.some((entry) => {
          if (typeof entry === 'string' && typeof expected === 'string') {
            return entry.toLowerCase().includes(expected.toLowerCase());
          }
          return entry === expected;
        });
      }
      return typeof actual === 'string' && typeof expected === 'string'
        && actual.toLowerCase().includes(expected.toLowerCase());
    case 'contains_any':
      if (!Array.isArray(expected)) {
        return false;
      }
      return expected.some((candidate) => evaluatePredicate(actual, 'contains', candidate));
    default:
      return false;
  }
}
'''
    write_module("scorer-predicate-eval.ts", module)

    src = insert_import_after_last_import(
        src,
        "import { evaluatePredicate, formatToolArgValue, getNestedValue } from './scorer-predicate-eval.js';",
    )

    block_start = "// ─────────────────────────────────────────────────────────────────────\n// Structured check helpers"
    block_end = "// ─────────────────────────────────────────────────────────────────────\n// RAGAS Context Relevance"
    block, src = extract_block(src, block_start, block_end)

    re_export_anchor = "} from './scorer-text-extractors.js';\n"
    if re_export_anchor in src:
        src = src.replace(
            re_export_anchor,
            re_export_anchor + "export { evaluatePredicate } from './scorer-predicate-eval.js';\n",
        )
    else:
        raise ValueError("text-extractors re-export anchor missing")

    write_scorer(src)


def extract_function_body(src: str, func_name: str) -> tuple[str, str]:
    """Extract from 'function name' or 'export function name' through closing brace at depth 0."""
    patterns = [f"function {func_name}(", f"export function {func_name}("]
    start = -1
    for p in patterns:
        idx = src.find(p)
        if idx != -1:
            start = src.rfind("\n", 0, idx) + 1
            break
    if start == -1:
        raise ValueError(f"function {func_name} not found")
    i = src.find("{", start)
    depth = 0
    j = i
    while j < len(src):
        c = src[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                j += 1
                break
        j += 1
    block = src[start:j]
    remainder = src[:start] + src[j:]
    return block, remainder


def step_step_efficiency() -> None:
    src = read_scorer()
    body, src = extract_function_body(src, "scoreStepEfficiency")
    module = f'''/**
 * Step-efficiency dimension scoring.
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type {{ ScenarioExpectation }} from './scenario.js';
import type {{ Diagnostic }} from './scorer.js';

{body.replace("function scoreStepEfficiency", "export function scoreStepEfficiency")}
'''
    write_module("scorer-step-efficiency.ts", module)
    src = insert_import_after_last_import(
        src, "import { scoreStepEfficiency } from './scorer-step-efficiency.js';"
    )
    write_scorer(src)


def step_tool_accuracy() -> None:
    src = read_scorer()
    # Extract isSearchWinesPartitionBatch
    batch_body, src = extract_function_body(src, "isSearchWinesPartitionBatch")
    tool_body, src = extract_function_body(src, "scoreToolAccuracy")

    module = f'''/**
 * Tool-accuracy dimension scoring.
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type {{ ScenarioExpectation }} from './scenario.js';
import type {{ Diagnostic, ToolCallTrace }} from './scorer.js';
import {{
  PENALTY_EXTRA_TOOL_PER_CALL,
  PENALTY_EXTRA_TOOL_CAP,
  PENALTY_TOOL_DUPLICATE,
  PENALTY_TOOL_ORDER_VIOLATION,
}} from './constants.js';
import {{ clamp01 }} from './scorer-aggregation.js';
import {{ countSemanticToolInvocations }} from './scorer-tool-call-signatures.js';
import {{ parseToolCallInput }} from './scorer-context-relevance.js';

{batch_body}

{tool_body.replace("function scoreToolAccuracy", "export function scoreToolAccuracy")}
'''
    write_module("scorer-tool-accuracy.ts", module)
    src = insert_import_after_last_import(
        src, "import { scoreToolAccuracy } from './scorer-tool-accuracy.js';"
    )
    # Remove parseToolCallInput from scorer imports if only used by isSearchWinesPartitionBatch
    src = src.replace(
        "import {\n  parseToolCallInput,\n  scoreContextRelevance,\n} from './scorer-context-relevance.js';",
        "import { scoreContextRelevance } from './scorer-context-relevance.js';",
    )
    write_scorer(src)


def step_answer_quality() -> None:
    src = read_scorer()
    body, src = extract_function_body(src, "scoreAnswerQuality")

    # Remove penalty constants only used by answer quality
    for const in [
        "const PENALTY_REGEX_MISS = 0.5;",
        "const PENALTY_MUST_NOT_MATCH = 0.50;",
    ]:
        src = src.replace(const + "\n", "")

    module = f'''/**
 * Answer-quality dimension scoring (heuristic contract checks).
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type {{ ScenarioExpectation }} from './scenario.js';
import type {{ Diagnostic }} from './scorer.js';
import {{ clamp01 }} from './scorer-aggregation.js';

/** Answer quality: 50% penalty per regex miss in answerMustMatch. */
const PENALTY_REGEX_MISS = 0.5;
/**
 * Answer quality: 50% penalty per answerMustNotMatch hit (v4 rebalanced from 0.20).
 * Non-fatal — judge can partially offset.
 */
const PENALTY_MUST_NOT_MATCH = 0.50;

{body.replace("function scoreAnswerQuality", "export function scoreAnswerQuality")}
'''
    write_module("scorer-answer-quality.ts", module)
    src = insert_import_after_last_import(
        src, "import { scoreAnswerQuality } from './scorer-answer-quality.js';"
    )
    write_scorer(src)


def step_structured_checks() -> None:
    src = read_scorer()
    body, src = extract_function_body(src, "scoreStructuredChecks")

    for const in [
        "const PENALTY_PRICE_BAND_VIOLATED = 0.7;",
        "const PENALTY_VINTAGE_RANGE_VIOLATED = 0.7;",
        "const PENALTY_DRINKING_WINDOW_MISMATCH = 0.8;",
        "const PENALTY_TOOL_ARG_MISSING = 0.7;",
        "const PENALTY_UNCITED_WINE_NAMES = 0.5;",
    ]:
        src = src.replace(const + "\n", "")

    # Remove structured checks section header comment block if orphaned
    src = re.sub(
        r"// ─+\n// Structured checks \(9 schema fields.*?\n// ─+\n\n",
        "",
        src,
        count=1,
    )

    module = f'''/**
 * Structured assertion checks (price band, vintage, tool args, citations).
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 * Returns a multiplier in (0, 1] applied to answerQuality.
 */

import type {{ ScenarioExpectation }} from './scenario.js';
import type {{ Diagnostic, ScenarioExecution }} from './scorer.js';
import {{ normalizeObservations }} from './scorer-abstention.js';
import {{
  evaluatePredicate,
  formatToolArgValue,
  getNestedValue,
}} from './scorer-predicate-eval.js';
import {{
  extractKoreanPrices,
  extractProperNouns,
  extractVintageYears,
}} from './scorer-text-extractors.js';

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

{body.replace("function scoreStructuredChecks", "export function scoreStructuredChecks")}
'''
    write_module("scorer-structured-checks.ts", module)
    src = insert_import_after_last_import(
        src, "import { scoreStructuredChecks } from './scorer-structured-checks.js';"
    )

    # Remove dimension scorers section if only comments left
    src = re.sub(
        r"// ─+\n// Dimension scorers\n// ─+\n\n",
        "",
        src,
        count=1,
    )

    write_scorer(src)


STEPS = {
    "predicate-eval": step_predicate_eval,
    "step-efficiency": step_step_efficiency,
    "tool-accuracy": step_tool_accuracy,
    "answer-quality": step_answer_quality,
    "structured-checks": step_structured_checks,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in STEPS:
        print(__doc__)
        sys.exit(1)
    STEPS[sys.argv[1]]()
    print(f"OK: {sys.argv[1]}")


if __name__ == "__main__":
    main()
