/**
 * Agent benchmark UI catalog must stay aligned with CLI runner quick profile.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_BENCHMARK_UI_SCENARIOS } from '../../src/domain/agent/benchmark-ui-scenarios.js';

function readSrc(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}

describe('Agent benchmark UI — catalog sync with runner quick profile', () => {
  it('R-BENCH-UI-01: UI scenario ids match runner QUICK_SCENARIO_IDS set', () => {
    const runnerSrc = readSrc('test/benchmark/agent/runner.ts');
    const block = runnerSrc.match(/const QUICK_SCENARIO_IDS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const declaredIds = [...block![1].matchAll(/\d+/g)].map((m) => Number(m[0]));
    const uiIds = new Set(AGENT_BENCHMARK_UI_SCENARIOS.map((s) => s.id));
    expect(uiIds.size).toBe(declaredIds.length);
    for (const id of declaredIds) {
      expect(uiIds.has(id)).toBe(true);
    }
  });

  it('R-BENCH-UI-02: exactly 20 quick scenarios', () => {
    expect(AGENT_BENCHMARK_UI_SCENARIOS).toHaveLength(20);
  });
});
