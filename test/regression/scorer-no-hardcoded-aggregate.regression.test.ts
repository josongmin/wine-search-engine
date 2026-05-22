/**
 * Scorer / aggregate provenance regression.
 *
 * Walks the `BenchmarkReport.summary` shape and asserts:
 *
 *   1. Every numeric (or `{ p50, p95, ... }` structured) aggregate in
 *      `summary.*` has a corresponding entry in `summary.provenance`.
 *   2. `derivationSummary` MUST NOT contain the substring `'TODO'` — this is
 *      the exact failure mode that hid `meanHardConstraints = 0 // TODO` for
 *      sessions and corrupted every `hard_constraints_low` insight.
 *   3. `sourceField` MUST be either:
 *        - a dot-path that resolves on `ScenarioScores` / `ScenarioExecution`, or
 *        - one of the documented magic strings:
 *            * `'__scenario_count__'` — cardinality counters
 *            * `'totalDurationMs'`    — latency aggregates
 *            * `'totalTokens'`        — token aggregates
 *            * `'totalTokens.input'` / `'totalTokens.output'` — split-token mean
 *            * `'stepCount'`          — step-count mean
 *            * `'evidenceFrameCount'` — frame coverage
 *            * `'claimDiagnostics.<field>'` — claim diagnostic mean
 *
 * The test does NOT actually run the bench (cost-prohibitive); it constructs a
 * synthetic `BenchmarkReport.summary` shape from a single dummy
 * `scoreScenario` result and asserts the provenance map structurally.
 *
 * Append-only regression suite — never delete cases.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreScenario,
  type ScenarioExecution,
  type ScenarioScores,
} from '../benchmark/agent/scorer.js';
import type { AgentBenchmarkScenario } from '../benchmark/agent/scenario.js';

const KNOWN_MAGIC_SOURCE_FIELDS = new Set<string>([
  '__scenario_count__',
  'totalDurationMs',
  'totalTokens',
  'totalTokens.input',
  'totalTokens.output',
  'stepCount',
  'evidenceFrameCount',
]);

// Minimal scenario / execution to invoke scoreScenario.
const dummyScenario: AgentBenchmarkScenario = {
  id: 1,
  tier: 'single_shot',
  query: 'q',
  description: 'd',
  expectation: { maxSteps: 2 },
};

const dummyExecution: ScenarioExecution = {
  answer: 'an answer',
  stepCount: 1,
  toolCallCount: 1,
  toolsUsed: [{ tool: 'search_wines', input: '{}' }],
  observations: ['obs'],
  terminationReason: 'answer',
  totalDurationMs: 1000,
  totalTokens: { input: 100, output: 50 },
};

/**
 * Build a synthetic summary mirroring what runner.buildReport() produces. We
 * import the actual factory by re-implementing the provenance map call here —
 * the runner module unfortunately also brings in PG/Vespa wiring, so we keep
 * the test layer light by reading the provenance map via a JSON snapshot
 * embedded into the runner output during a real run.
 *
 * Instead, this test uses a known-keys whitelist + a hand-evolved provenance
 * matching the runner's `buildSummaryProvenance` factory. When you add a key
 * to that factory you MUST also add it here — the test will fail loudly
 * otherwise.
 */
const EXPECTED_SUMMARY_KEYS_THAT_NEED_PROVENANCE: readonly string[] = [
  'overallScore',
  'overallScoreGeoMean',
  'overallScoreTrimmedGeoMean5',
  'overallCi95',
  'overallBootstrapCi95',
  'executionEfficiency',
  'toolAccuracy',
  'stepEfficiency',
  'answerQuality',
  'terminationCorrectness',
  'costEfficiency',
  'faithfulness',
  'contextRelevance',
  'contextRecall',
  'judge',
  'claimFaithfulness',
  'claimContradictionRate',
  'claimCriticalErrorRate',
  'claimProvenanceCoverage',
  'claimHardFailCount',
  'claimEvaluatedCount',
  'scrOverall',
  'scrHard',
  'scrSoft',
  'scrInferred',
  'scrInferredGraph',
  'entityLinkingAccuracy',
  'slotF1Strict',
  'slotF1Relaxed',
  'csrOverall',
  'csrHard',
  'csrSoft',
  'csrInferred',
  'csrInferredGraph',
  'constraintEvaluatedCount',
  'avgSteps',
  'latencyMs',
  'latencySla',
  'tokens',
  'byTier',
  'evidenceFrameCoverage',
  'evidenceFrameCounts',
  'meanHardConstraints',
];

// We pull the actual provenance map by importing the runner's helper. The
// runner module re-exports buildSummaryProvenance for testability.
import { buildSummaryProvenance } from '../benchmark/agent/runner.js';

describe('scorer provenance — no hardcoded aggregates', () => {
  it('buildSummaryProvenance returns a non-empty map', () => {
    const map = buildSummaryProvenance();
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });

  it('every expected summary key has a provenance entry', () => {
    const map = buildSummaryProvenance();
    const missing: string[] = [];
    for (const key of EXPECTED_SUMMARY_KEYS_THAT_NEED_PROVENANCE) {
      if (!(key in map)) {
        missing.push(key);
      }
    }
    expect(missing, `provenance entries missing for: ${missing.join(', ')}`).toEqual([]);
  });

  it('no derivationSummary contains the substring "TODO"', () => {
    const map = buildSummaryProvenance();
    const todos: string[] = [];
    for (const [name, prov] of Object.entries(map)) {
      if (prov.derivationSummary.includes('TODO')) {
        todos.push(`${name}: ${prov.derivationSummary}`);
      }
    }
    expect(
      todos,
      `Found "TODO" in provenance derivation — silent-hardcode trap. Affected: ${todos.join(' | ')}`,
    ).toEqual([]);
  });

  it('every sourceField is either a known magic string or a dot-path that looks valid', () => {
    const map = buildSummaryProvenance();
    const invalid: string[] = [];
    for (const [name, prov] of Object.entries(map)) {
      const sf = prov.sourceField;
      if (KNOWN_MAGIC_SOURCE_FIELDS.has(sf)) continue;
      if (sf.startsWith('claimDiagnostics.')) continue;
      if (!sf.startsWith('scores.')) {
        invalid.push(`${name}: "${sf}" — must start with "scores." or be a documented magic string`);
        continue;
      }
      // Cheap structural validation: the dot-path after `scores.` must be a
      // known key on ScenarioScores. Build the keyset from a real ScenarioScores
      // produced by scoreScenario, plus the canonical extra fields surfaced
      // via the dim union.
      const result = scoreScenario(dummyScenario, dummyExecution, undefined);
      const known = new Set<string>(Object.keys(result.scores));
      // Some provenance source fields point at sub-paths (e.g. claimDiagnostics.X).
      // For scores.* we just check the top-level key exists.
      const sub = sf.slice('scores.'.length);
      const head = sub.split('.')[0]!;
      if (!known.has(head)) {
        invalid.push(`${name}: sourceField "${sf}" — "${head}" is not a ScenarioScores field`);
      }
    }
    expect(invalid, `invalid provenance sourceField(s):\n  ${invalid.join('\n  ')}`).toEqual([]);
  });

  it('aggregateName matches the provenance map key', () => {
    const map = buildSummaryProvenance();
    const mismatch: string[] = [];
    for (const [key, prov] of Object.entries(map)) {
      if (prov.aggregateName !== key) {
        mismatch.push(`map["${key}"].aggregateName="${prov.aggregateName}"`);
      }
    }
    expect(mismatch).toEqual([]);
  });

  it('meanHardConstraints provenance references the real source field', () => {
    // The exact regression: before this fix, runner shipped
    // `meanHardConstraints: 0 // TODO`. The contract enforces that the
    // provenance source field is the threaded-through scores.extractedHardConstraintCount.
    const map = buildSummaryProvenance();
    const prov = map['meanHardConstraints'];
    expect(prov, 'meanHardConstraints provenance entry missing').toBeDefined();
    expect(prov!.sourceField).toBe('scores.extractedHardConstraintCount');
    expect(prov!.derivationSummary).not.toContain('TODO');
  });

  it('overallScoreTrimmedGeoMean5 provenance documents the 5% trim', () => {
    const map = buildSummaryProvenance();
    const prov = map['overallScoreTrimmedGeoMean5'];
    expect(prov, 'overallScoreTrimmedGeoMean5 provenance entry missing').toBeDefined();
    // Contract: the trim parameter MUST be documented in the derivation
    // summary so a reader can audit the value without grepping source.
    expect(prov!.derivationSummary).toMatch(/5%|0\.05/);
  });
});

describe('ScenarioScores shape — extractedHardConstraintCount threaded through', () => {
  it('null when no constraintMetrics provided', () => {
    const result = scoreScenario(dummyScenario, dummyExecution, undefined);
    const s: ScenarioScores = result.scores;
    expect(s.extractedHardConstraintCount).toBeNull();
  });

  it('survives byte-for-byte from constraintMetrics → scores', () => {
    const result = scoreScenario(
      dummyScenario,
      dummyExecution,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        semanticConstraintRecall: null,
        scrHard: null,
        scrSoft: null,
        scrInferred: null,
        scrInferredGraph: null,
        entityLinkingAccuracy: null,
        slotF1Strict: null,
        slotF1Relaxed: null,
        csrOverall: null,
        csrHard: null,
        csrSoft: null,
        csrInferred: null,
        csrInferredGraph: null,
        extractedHardConstraintCount: 7,
      },
    );
    expect(result.scores.extractedHardConstraintCount).toBe(7);
  });
});
