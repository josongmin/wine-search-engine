/**
 * Regression tests — EMPTY_ANSWER fallback guarantee.
 *
 * APPEND-ONLY. Locks in the 4-layer fallback fix in agent-orchestrator.ts.
 *
 * Tests verify the orchestrator's synthesis / fallback constants and that
 * Layer 3 (last-observation) + Layer 4 (absolute template) are structurally
 * reachable. Full integration tests (mocking the LLM) live in the e2e suite.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Part 1: SYNTHESIS_TIMEOUT_MS constant is set to >= 12s
// ---------------------------------------------------------------------------

describe('EMPTY_ANSWER fallback regression — synthesis timeout constant', () => {
  it('R-EMPTY-01: SYNTHESIS_TIMEOUT_MS exported from orchestrator is at least 12000ms', async () => {
    // We test the value indirectly by importing the module and verifying the
    // constant is accessible (and not the old 8000ms value). The orchestrator
    // does not export it publicly, so we verify via side-channel:
    // Read the source file and check the literal.
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // Must contain the named const at module scope with a value >= 12_000.
    // Accepted values: 12_000 (original fix) or larger (e.g. 60_000 after LLM latency tuning).
    expect(src).toMatch(/const SYNTHESIS_TIMEOUT_MS\s*=\s*(?:1[2-9]|[2-9]\d|\d{3,})[_0-9]*/);
    // Must NOT contain the old 8_000 value assigned to this const
    expect(src).not.toMatch(/const SYNTHESIS_TIMEOUT_MS\s*=\s*8[_0-9]*/);
  });
});

// ---------------------------------------------------------------------------
// Part 2: Layer 3 and Layer 4 guards exist in orchestrator source
// ---------------------------------------------------------------------------

describe('EMPTY_ANSWER fallback regression — layer 3 and 4 guards present', () => {
  it('R-EMPTY-02: Layer 3 (last-observation summary) guard exists in orchestrator', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // Layer 3 uses findLast to grab the last step with an observation
    expect(src).toMatch(/findLast/);
    expect(src).toMatch(/Layer 3/);
  });

  it('R-EMPTY-03: Layer 4 (absolute template) guard exists in orchestrator', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toMatch(/Layer 4/);
    // The template must be in Korean (matching existing answer strings)
    expect(src).toMatch(/처리하지 못했습니다/);
  });

  it('R-EMPTY-04: fallback search no-result branch sets answer to non-empty Korean template', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // The else branch when topResult is undefined must set answer to a Korean string
    expect(src).toMatch(/검색 결과를 찾지 못했습니다/);
  });

  it('R-EMPTY-05: synthesis failure logs at error level (not warn)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // After fix: synthesis failure must log.error (not log.warn).
    // There are now 2 separate catch blocks (attempt 1 + attempt 2), both must use log.error.
    // Verify no log.warn for synthesis failures.
    expect(src).toMatch(/synthesis attempt.*threw.*\n.*log\.error/s);
    expect(src).not.toMatch(/synthesis.*threw.*\n.*log\.warn/s);
  });

  it('R-EMPTY-06: fallback search failure logs at error level (not warn)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // After fix: fallback search failure must log.error
    expect(src).toMatch(/agent fallback search failed.*\n.*log\.error|log\.error.*agent fallback search failed/s);
  });
});

// ---------------------------------------------------------------------------
// Part 3: Structural check — answer can never be '' after all 4 layers
// ---------------------------------------------------------------------------

describe('EMPTY_ANSWER fallback regression — structural guarantee', () => {
  it('R-EMPTY-07: Layer 4 template string is non-empty and Korean', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // The Layer 4 unconditional answer assignment must be non-empty Korean string
    // Matches both backtick template literals and single/double quoted strings
    const layer4Match = src.match(/Layer 4[\s\S]{0,400}answer\s*=\s*['"`]([^'"`]+)['"`]/);
    expect(layer4Match).not.toBeNull();
    if (layer4Match?.[1]) {
      expect(layer4Match[1].trim().length).toBeGreaterThan(10);
      // Must contain Korean characters
      expect(layer4Match[1]).toMatch(/[\uAC00-\uD7A3]/);
    }
  });

  it('R-EMPTY-08: Layer 3 slices observation to max 300 chars (prevents oversized fallback)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // Layer 3 must use .slice(0, LAYER3_OBSERVATION_SLICE_CHARS) or literal .slice(0, 300).
    // After the magic-number lint fix the literal was replaced with the named constant.
    const hasLiteralSlice = /\.slice\(0,\s*300\)/.test(src);
    const hasNamedConstant = /const LAYER3_OBSERVATION_SLICE_CHARS\s*=\s*300/.test(src) &&
      /\.slice\(0,\s*LAYER3_OBSERVATION_SLICE_CHARS\)/.test(src);
    expect(hasLiteralSlice || hasNamedConstant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Tool-observation-aware terminationReason fix (FALLBACK_TERMINATION fix)
//
// When the agent successfully called tools (has observations) but the final
// synthesis LLM call fails, terminationReason must be 'answer', not 'fallback'.
// 'fallback' should only apply when NO tool calls were made at all.
// ---------------------------------------------------------------------------

describe('EMPTY_ANSWER fallback regression — tool-observation-aware terminationReason', () => {
  it('R-EMPTY-09: Layer 2 fallback search is skipped when hasToolObservations is true', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // The guard must check !hasToolObservations before running Layer 2 search
    expect(src).toMatch(/hasToolObservations/);
    expect(src).toMatch(/!hasToolObservations/);
    // Layer 2 condition must include the !hasToolObservations guard
    expect(src).toMatch(/answer === '' && terminationReason !== 'answer' && !hasToolObservations/);
  });

  it('R-EMPTY-10: Layer 3 sets terminationReason=answer when tool observations exist', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // Layer 3 must use ternary or conditional to set 'answer' vs 'fallback'
    // based on whether tool observations exist
    expect(src).toMatch(/hasToolObservations \? 'answer' : 'fallback'/);
  });

  it('R-EMPTY-11: Layer 4 sets terminationReason=answer when tool observations exist', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../src/application/agent/agent-orchestrator.ts', import.meta.url),
      'utf-8',
    );
    // Confirm Layer 4 also uses the same ternary (both Layer 3 and 4 must have it)
    const matches = src.match(/hasToolObservations \? 'answer' : 'fallback'/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});
