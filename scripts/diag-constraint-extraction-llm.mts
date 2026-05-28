/**
 * Diagnostic: per-scenario constraint extraction with LLM linker enabled.
 *
 * Unlike the offline rig (no LLM), this script uses the full LlmNLMapper
 * pipeline so that phrases the rule table misses are handled by the LLM.
 *
 * Requires OPENAI_API_KEY/OPENAI_API_KEYS or a valid Codex ChatGPT login token.
 *
 * Usage:  npx tsx scripts/diag-constraint-extraction-llm.mts
 */

import 'dotenv/config';

import { AGENT_SCENARIOS } from '../test/benchmark/agent/scenarios.js';
import { scoreSemanticConstraintRecall } from '../test/benchmark/agent/constraint-metrics.js';
import { NLMapper } from '../src/domain/attribute/service/nl-mapper.js';
import { LlmNLMapper } from '../src/domain/attribute/service/llm-nl-mapper.js';
import { createChatLlmFromEnv } from '../src/infrastructure/ai/chat-llm-from-env.js';
import { ConstraintCompiler } from '../src/domain/query/service/constraint-compiler.js';
import { QueryNormalizer } from '../src/domain/query/service/query-normalizer.js';
import { correctKoreanWineTypos } from '../src/domain/query/service/korean-wine-aliases.js';
import type { MappingTablePort } from '../src/domain/attribute/port/mapping-table.port.js';
import type { ConstraintBundle } from '../src/domain/shared/types/index.js';
import type { ConstraintGraph } from '../src/domain/query/model/constraint-graph.js';

const NO_OP_MAPPING_TABLE: MappingTablePort = {
  async findMapping(): Promise<null> { return null; },
  async findMappingsByAttribute(): Promise<readonly never[]> { return []; },
  async getCurrentVersion(): Promise<string> { return 'noop-v1.0'; },
};

const OPENAI_MODEL = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
const chatLlm = createChatLlmFromEnv({
  env: process.env,
  defaultModel: OPENAI_MODEL,
  httpTimeoutMs: 10_000,
  allowCodexFallback: true,
});
if (chatLlm === undefined) {
  console.error('OPENAI_API_KEY/OPENAI_API_KEYS or a valid Codex ChatGPT login token is required.');
  process.exit(1);
}

const LLM_TIMEOUT_MS = 15_000;
const llmMapper = new LlmNLMapper(NO_OP_MAPPING_TABLE, chatLlm, LLM_TIMEOUT_MS);
const ruleOnlyMapper = new NLMapper(NO_OP_MAPPING_TABLE);
const normalizer = new QueryNormalizer();

async function extractWithMapper(
  query: string,
  mapper: NLMapper,
): Promise<{ bundle: ConstraintBundle; graph?: ConstraintGraph }> {
  const normalizedQuery = normalizer.normalize(correctKoreanWineTypos(query)).accentless;
  const compiler = new ConstraintCompiler(mapper);
  const compiled = await compiler.compile(normalizedQuery);
  return {
    bundle: compiled.bundle,
    ...(compiled.constraintGraph !== undefined ? { constraintGraph: compiled.constraintGraph } : {}),
  };
}

async function main(): Promise<void> {
  const withExpected = AGENT_SCENARIOS.filter(
    (s) => s.expectation.expectedConstraints !== undefined,
  );

  console.log(`\n=== Constraint Extraction: Rule-Only vs LLM (${withExpected.length} scenarios) ===\n`);

  let ruleHardHit = 0, ruleHardTotal = 0;
  let ruleSoftHit = 0, ruleSoftTotal = 0;
  let llmHardHit = 0, llmHardTotal = 0;
  let llmSoftHit = 0, llmSoftTotal = 0;
  let llmImproved = 0;

  for (const scenario of withExpected) {
    const expected = scenario.expectation.expectedConstraints;
    if (expected === undefined) {
      continue;
    }

    // Rule-only extraction
    const ruleResult = await extractWithMapper(scenario.query, ruleOnlyMapper);
    const ruleScr = scoreSemanticConstraintRecall(ruleResult.bundle, expected, 'relaxed');

    // LLM extraction
    let llmScr;
    let llmResult;
    try {
      llmResult = await extractWithMapper(scenario.query, llmMapper);
      llmScr = scoreSemanticConstraintRecall(llmResult.bundle, expected, 'relaxed');
    } catch (err) {
      console.log(`[id=${scenario.id}] LLM error: ${err instanceof Error ? err.message : String(err)}`);
      llmScr = ruleScr; // fallback
      llmResult = ruleResult;
    }

    // Count
    const hardCount = expected.hard?.length ?? 0;
    const softCount = expected.soft?.length ?? 0;
    if (ruleScr.scrHard !== null) { ruleHardHit += ruleScr.scrHard * hardCount; ruleHardTotal += hardCount; }
    if (ruleScr.scrSoft !== null) { ruleSoftHit += ruleScr.scrSoft * softCount; ruleSoftTotal += softCount; }
    if (llmScr.scrHard !== null) { llmHardHit += llmScr.scrHard * hardCount; llmHardTotal += hardCount; }
    if (llmScr.scrSoft !== null) { llmSoftHit += llmScr.scrSoft * softCount; llmSoftTotal += softCount; }

    const ruleOverall = ruleScr.scrOverall ?? 0;
    const llmOverall = llmScr.scrOverall ?? 0;
    const improved = llmOverall > ruleOverall + 0.001;
    if (improved) llmImproved++;

    // Print only scenarios where LLM made a difference, or where both fail
    const bothFail = ruleScr.missedConstraints.length > 0 && llmScr.missedConstraints.length > 0;
    const llmHelped = improved;
    if (llmHelped || bothFail) {
      const tag = llmHelped ? '🔺 LLM IMPROVED' : '⬜ BOTH MISS';
      console.log(`[id=${scenario.id}] ${tag} | "${scenario.query}"`);
      console.log(`  Rule: scrHard=${fmt(ruleScr.scrHard)} scrSoft=${fmt(ruleScr.scrSoft)} overall=${fmt(ruleOverall)}`);
      console.log(`  LLM:  scrHard=${fmt(llmScr.scrHard)} scrSoft=${fmt(llmScr.scrSoft)} overall=${fmt(llmOverall)}`);
      if (llmScr.missedConstraints.length > 0) {
        console.log(`  LLM still missed: ${llmScr.missedConstraints.map(c => `${c.attribute}${c.operator}${JSON.stringify(c.value)}`).join(', ')}`);
      }
      console.log();
    }
  }

  console.log(`=== AGGREGATE ===`);
  console.log(`  Rule-only Hard: ${Math.round(ruleHardHit)}/${ruleHardTotal} (${(ruleHardHit / Math.max(ruleHardTotal, 1) * 100).toFixed(1)}%)`);
  console.log(`  LLM       Hard: ${Math.round(llmHardHit)}/${llmHardTotal} (${(llmHardHit / Math.max(llmHardTotal, 1) * 100).toFixed(1)}%)`);
  console.log(`  Rule-only Soft: ${Math.round(ruleSoftHit)}/${ruleSoftTotal} (${(ruleSoftHit / Math.max(ruleSoftTotal, 1) * 100).toFixed(1)}%)`);
  console.log(`  LLM       Soft: ${Math.round(llmSoftHit)}/${llmSoftTotal} (${(llmSoftHit / Math.max(llmSoftTotal, 1) * 100).toFixed(1)}%)`);
  console.log(`  LLM improved: ${llmImproved} / ${withExpected.length} scenarios`);
  console.log();
}

function fmt(v: number | null): string {
  return v === null ? 'null' : v.toFixed(3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
