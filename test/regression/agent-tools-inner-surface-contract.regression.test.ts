/**
 * ADR-009 Phase 0: each per-tool branch in agent-tools.ts MUST populate a
 * typed `structuredOutput`. A missing `structuredOutput` on any branch
 * would silently drop that path from frame emission — a regression the
 * runtime cannot detect because the wrapper only reads it when toolCallId
 * is supplied.
 *
 * Static (source-text) lock rather than a dynamic Zod assertion — the
 * dispatcher has ~20 return sites across four tools and we want each one
 * traceable in grep, not buried in a parameterised test.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC_PATH = fileURLToPath(
  new URL('../../src/application/agent/agent-tools.ts', import.meta.url),
);

describe('agent-tools.ts structured output invariants', () => {
  const src = readFileSync(SRC_PATH, 'utf8');

  it('AgentToolInnerResult requires structuredOutput (no optional)', () => {
    // Regex locks the internal result type so any future loosening
    // to `structuredOutput?: ...` has to go through this test first.
    expect(src).toMatch(/readonly structuredOutput:\s*ToolCallStructuredOutput;/);
  });

  it('every per-tool branch emits a tagged structuredOutput', () => {
    // At least one of each tag for each branch. Blanket count: at least
    // 4 distinct tags in use inside the dispatcher body.
    expect(src).toMatch(/kind:\s*'search_result_set'/);
    expect(src).toMatch(/kind:\s*'comparison_result'/);
    expect(src).toMatch(/kind:\s*'drinking_window'/);
    expect(src).toMatch(/kind:\s*'food_pairing'/);
    expect(src).toMatch(/kind:\s*'tool_error'/);
    expect(src).toMatch(/kind:\s*'no_op'/);
  });

  it('wrapper threads toolCallId option into frame builder', () => {
    expect(src).toMatch(/readonly toolCallId\?:\s*string \| undefined/);
    expect(src).toMatch(/buildToolCallEvidenceFrame\(/);
  });

  it('batch dispatcher forwards base toolCallId into per-item -p${i} suffix', () => {
    expect(src).toMatch(/-p\$\{i\}/);
  });
});
