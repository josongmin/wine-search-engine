/**
 * Diagnostic: per-scenario constraint extraction RCA.
 *
 * Runs the offline extraction rig (no LLM / no Vespa) and prints
 * per-scenario scrHard / scrSoft / scrInferred with exact missed constraints.
 *
 * Usage:  npx tsx scripts/diag-constraint-extraction.mts
 */

import { AGENT_SCENARIOS } from '../test/benchmark/agent/scenarios.js';
import { runConstraintExtraction } from '../test/benchmark/agent/constraint-extraction-eval.js';
import {
  scoreSemanticConstraintRecall,
  scoreSlotF1,
} from '../test/benchmark/agent/constraint-metrics.js';

interface ScenarioResult {
  id: number;
  tier: string;
  query: string;
  scrHard: number | null;
  scrSoft: number | null;
  scrInferred: number | null;
  scrInferredGraph: number | null;
  slotF1Strict: number | null;
  slotF1Relaxed: number | null;
  missedConstraints: readonly { attribute: string; operator: string; value: unknown; tier: string }[];
  extractedHard: readonly { attribute: string; operator: string; value: unknown }[];
  extractedSoft: readonly { attribute: string; operator: string; value: unknown }[];
  extractedInferred: readonly { attribute: string; operator: string; value: unknown }[];
}

async function main(): Promise<void> {
  const withExpected = AGENT_SCENARIOS.filter(
    (s) => s.expectation.expectedConstraints !== undefined,
  );

  console.log(`\n=== Constraint Extraction RCA (${withExpected.length} scenarios) ===\n`);

  const results: ScenarioResult[] = [];
  let totalMissedHard = 0;
  let totalExpectedHard = 0;
  let totalMissedSoft = 0;
  let totalExpectedSoft = 0;
  let totalMissedInferred = 0;
  let totalExpectedInferred = 0;

  for (const scenario of withExpected) {
    const expected = scenario.expectation.expectedConstraints!;
    const extraction = await runConstraintExtraction(scenario.query);
    const scr = scoreSemanticConstraintRecall(
      extraction.bundle,
      expected,
      'relaxed',
      extraction.constraintGraph,
    );
    const f1 = scoreSlotF1(extraction.bundle, expected);

    const missed = scr.missedConstraints.map((c) => {
      const tier =
        expected.hard?.includes(c) ? 'hard'
        : expected.soft?.includes(c) ? 'soft'
        : 'inferred';
      return { attribute: c.attribute, operator: c.operator, value: c.value, tier };
    });

    const hardExpectedCount = expected.hard?.length ?? 0;
    const softExpectedCount = expected.soft?.length ?? 0;
    const inferredExpectedCount = expected.inferred?.length ?? 0;
    const hardMissed = missed.filter((m) => m.tier === 'hard').length;
    const softMissed = missed.filter((m) => m.tier === 'soft').length;
    const inferredMissed = missed.filter((m) => m.tier === 'inferred').length;

    totalExpectedHard += hardExpectedCount;
    totalExpectedSoft += softExpectedCount;
    totalExpectedInferred += inferredExpectedCount;
    totalMissedHard += hardMissed;
    totalMissedSoft += softMissed;
    totalMissedInferred += inferredMissed;

    const brief = (cs: readonly { attribute: string; operator: string; value: unknown }[]) =>
      cs.map((c) => `${c.attribute}${c.operator}${JSON.stringify(c.value)}`);

    results.push({
      id: scenario.id,
      tier: scenario.tier,
      query: scenario.query,
      scrHard: scr.scrHard,
      scrSoft: scr.scrSoft,
      scrInferred: scr.scrInferred,
      scrInferredGraph: scr.scrInferredGraph,
      slotF1Strict: f1.strict,
      slotF1Relaxed: f1.relaxed,
      missedConstraints: missed,
      extractedHard: extraction.bundle.hard.map((c) => ({ attribute: c.attribute, operator: c.operator, value: c.value })),
      extractedSoft: extraction.bundle.soft.map((c) => ({ attribute: c.attribute, operator: c.operator, value: c.value })),
      extractedInferred: extraction.bundle.inferred.map((c) => ({ attribute: c.attribute, operator: c.operator, value: c.value })),
    });
  }

  // Print failures only
  const failures = results.filter((r) => r.missedConstraints.length > 0);
  console.log(`--- FAILURES (${failures.length} / ${results.length} scenarios have misses) ---\n`);

  for (const r of failures) {
    console.log(`[id=${r.id}] ${r.tier} | "${r.query}"`);
    console.log(`  scrHard=${fmt(r.scrHard)} scrSoft=${fmt(r.scrSoft)} scrInferred=${fmt(r.scrInferred)} scrInferredGraph=${fmt(r.scrInferredGraph)}`);
    console.log(`  slotF1.strict=${fmt(r.slotF1Strict)} slotF1.relaxed=${fmt(r.slotF1Relaxed)}`);
    console.log(`  MISSED:`);
    for (const m of r.missedConstraints) {
      console.log(`    [${m.tier}] ${m.attribute} ${m.operator} ${JSON.stringify(m.value)}`);
    }
    console.log(`  EXTRACTED hard:     ${JSON.stringify(r.extractedHard.map(brief1))}`);
    console.log(`  EXTRACTED soft:     ${JSON.stringify(r.extractedSoft.map(brief1))}`);
    console.log(`  EXTRACTED inferred: ${JSON.stringify(r.extractedInferred.map(brief1))}`);
    console.log();
  }

  // Print passing scenarios briefly
  const passing = results.filter((r) => r.missedConstraints.length === 0);
  if (passing.length > 0) {
    console.log(`--- PASSING (${passing.length} scenarios) ---`);
    for (const r of passing) {
      console.log(`  [id=${r.id}] "${r.query}" — scrHard=${fmt(r.scrHard)} scrSoft=${fmt(r.scrSoft)} F1=${fmt(r.slotF1Relaxed)}`);
    }
    console.log();
  }

  // Aggregate
  console.log(`=== AGGREGATE ===`);
  console.log(`  Hard:     ${totalExpectedHard - totalMissedHard}/${totalExpectedHard} hit (${((1 - totalMissedHard / Math.max(totalExpectedHard, 1)) * 100).toFixed(1)}%)`);
  console.log(`  Soft:     ${totalExpectedSoft - totalMissedSoft}/${totalExpectedSoft} hit (${((1 - totalMissedSoft / Math.max(totalExpectedSoft, 1)) * 100).toFixed(1)}%)`);
  console.log(`  Inferred: ${totalExpectedInferred - totalMissedInferred}/${totalExpectedInferred} hit (${((1 - totalMissedInferred / Math.max(totalExpectedInferred, 1)) * 100).toFixed(1)}%)`);
  console.log();
}

function fmt(v: number | null): string {
  return v === null ? 'null' : v.toFixed(3);
}

function brief1(c: { attribute: string; operator: string; value: unknown }): string {
  return `${c.attribute}${c.operator}${JSON.stringify(c.value)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
