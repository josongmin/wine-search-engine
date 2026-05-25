#!/usr/bin/env python3
"""Split scorer.test.ts into dim-aligned test modules. Usage: python3 scripts/split-scorer-test.py [all|helpers]"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "test/benchmark/agent/__tests__/scorer.test.ts"
HELPERS = ROOT / "test/benchmark/agent/__tests__/__helpers__/scorer-test-helpers.ts"
OUT_DIR = ROOT / "test/benchmark/agent/__tests__"

# describe start line -> target file stem (without .test.ts)
TARGET_BY_LINE: dict[int, str] = {
    69: "scorer-orchestrator",
    89: "scorer-orchestrator",
    135: "scorer-tool-accuracy",
    277: "scorer-step-efficiency",
    336: "scorer-answer-quality",
    399: "scorer-termination",
    450: "scorer-cost-efficiency",
    527: "scorer-aggregation",
    601: "scorer-orchestrator",
    654: "scorer-orchestrator",
    742: "scorer-orchestrator",
    843: "scorer-orchestrator",
    882: "scorer-aggregation",
    924: "scorer-aggregation",
    990: "scorer-structured-checks",
    1207: "scorer-orchestrator",
    1249: "scorer-context-relevance",
    1603: "scorer-context-recall",
    1761: "scorer-orchestrator",
    1805: "scorer-orchestrator",
    1888: "scorer-tool-accuracy",
    1973: "scorer-orchestrator",
    1997: "scorer-aggregation",
    2030: "scorer-aggregation",
    2083: "scorer-abstention",
    2154: "scorer-aggregation",
    2182: "scorer-aggregation",
    2225: "scorer-context-relevance",
    2282: "scorer-text-extractors",
    2315: "scorer-text-extractors",
    2347: "scorer-termination",
    2406: "scorer-structured-checks",
    2484: "scorer-korean-clr",
    2525: "scorer-aggregation",
    2546: "constraint-metrics",
    2666: "constraint-metrics",
    2715: "constraint-metrics",
    2751: "constraint-metrics",
    2845: "scorer-exact-lookup-contract",
}

IMPORTS: dict[str, str] = {
    "scorer-orchestrator": """import { describe, it, expect } from 'vitest';
import { scoreScenario, DEFAULT_WEIGHTS, TIER_WEIGHTS } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-tool-accuracy": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-step-efficiency": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-answer-quality": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-termination": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-cost-efficiency": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-aggregation": """import { describe, it, expect } from 'vitest';
import { scoreScenario, DEFAULT_WEIGHTS, TIER_WEIGHTS } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-structured-checks": """import { describe, it, expect } from 'vitest';
import { scoreScenario, evaluatePredicate } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-context-relevance": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import {
  makeScenario,
  makeExecution,
  makeEvidenceFrame,
  tool,
} from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-context-recall": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-abstention": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-text-extractors": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-korean-clr": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "scorer-exact-lookup-contract": """import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';
""",
    "constraint-metrics": """import { describe, it, expect } from 'vitest';
import {
  scoreConstraintSatisfactionRate,
  scoreUDCG,
  scoreUDCGPair,
  scoreBrierCalibration,
  computeJudgeSCRCorrelation,
} from '../constraint-metrics.js';
import type { ConstraintBundle } from '../../../../src/domain/shared/types/constraint-bundle.js';
""",
}


def parse_blocks(text: str) -> list[tuple[int, str, str]]:
    lines = text.splitlines(keepends=True)
    starts: list[tuple[int, str]] = []
    for i, line in enumerate(lines, 1):
        m = re.match(r"^describe\('([^']+)'", line)
        if m:
            starts.append((i, m.group(1)))
    blocks: list[tuple[int, str, str]] = []
    for idx, (ln, name) in enumerate(starts):
        end_ln = starts[idx + 1][0] - 1 if idx + 1 < len(starts) else len(lines)
        # include preceding section comment lines
        start_idx = ln - 1
        while start_idx > 0 and lines[start_idx - 1].startswith("//"):
            start_idx -= 1
        body = "".join(lines[start_idx:end_ln])
        blocks.append((ln, name, body))
    return blocks


def extract_helpers(text: str) -> str:
    m = re.search(
        r"// ─+\n// Helpers\n// ─+\n\n(.*?)\n// ─+\n// Skipped",
        text,
        re.DOTALL,
    )
    if not m:
        raise ValueError("helpers section not found")
    helpers_body = m.group(1)
    body = helpers_body
    body = body.replace("function makeScenario(", "export function makeScenario(")
    body = body.replace("function makeExecution(", "export function makeExecution(")
    body = body.replace("function makeEvidenceFrame(", "export function makeEvidenceFrame(")
    body = body.replace("const tool = ", "export const tool = ")
    return f"""/**
 * Shared fixtures for benchmark scorer tests.
 * Extracted from scorer.test.ts during the 2026-05-26 test decomposition.
 */

import type {{ AgentBenchmarkScenario, ScenarioExpectation }} from '../../scenario.js';
import type {{ ScenarioExecution, ToolCallTrace }} from '../../scorer.js';
import type {{ ToolCallEvidenceFrame }} from '../../../../../src/domain/agent/model/tool-call-evidence-frame.js';

{body}"""


def write_helpers(text: str) -> None:
    HELPERS.parent.mkdir(parents=True, exist_ok=True)
    HELPERS.write_text(extract_helpers(text), encoding="utf-8")


def split_all(text: str) -> dict[str, list[str]]:
    blocks = parse_blocks(text)
    buckets: dict[str, list[str]] = {}
    for ln, _name, body in blocks:
        stem = TARGET_BY_LINE.get(ln)
        if stem is None:
            raise ValueError(f"no target for describe at line {ln}")
        buckets.setdefault(stem, []).append(body)
    return buckets


def write_test_files(buckets: dict[str, list[str]]) -> None:
    for stem, bodies in sorted(buckets.items()):
        path = OUT_DIR / f"{stem}.test.ts"
        content = IMPORTS[stem] + "\n" + "\n".join(bodies)
        path.write_text(content, encoding="utf-8")
        print(f"Wrote {path.name} ({len(bodies)} describes, {path.stat().st_size} bytes)")


def step_helpers() -> None:
    text = SRC.read_text(encoding="utf-8")
    write_helpers(text)
    print(f"OK: helpers -> {HELPERS}")


def step_all() -> None:
    if not SRC.exists():
        print("scorer.test.ts already split")
        return
    text = SRC.read_text(encoding="utf-8")
    write_helpers(text)
    buckets = split_all(text)
    write_test_files(buckets)
    SRC.unlink()
    print(f"Removed {SRC}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd == "helpers":
        step_helpers()
    elif cmd == "all":
        step_all()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
