/**
 * Agent benchmark runner.
 *
 * Usage:
 *   npx tsx test/benchmark/agent/runner.ts
 *   npx tsx test/benchmark/agent/runner.ts --tier single_shot
 *   npx tsx test/benchmark/agent/runner.ts --id 1,2,3
 *
 * Requires OPENAI_API_KEY in environment (uses real LLM).
 * Outputs JSON report to stdout, human-readable summary to stderr.
 */

import { loadConfig } from '../../../src/config/env.js';
import { AgentOrchestrator } from '../../../src/application/agent/agent-orchestrator.js';
import { OpenAiChatLlm } from '../../../src/infrastructure/ai/openai-chat-llm.js';
import { AGENT_SCENARIOS } from './scenarios.js';
import { scoreScenario, type ScenarioResult } from './scorer.js';
import type { AgentBenchmarkScenario, ScenarioTier } from './scenario.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { tierFilter?: ScenarioTier; idFilter?: readonly number[] } {
  const args = process.argv.slice(2);
  let tierFilter: ScenarioTier | undefined;
  let idFilter: readonly number[] | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && args[i + 1]) {
      tierFilter = args[i + 1] as ScenarioTier;
      i++;
    }
    if (args[i] === '--id' && args[i + 1]) {
      idFilter = args[i + 1]!.split(',').map(Number);
      i++;
    }
  }

  return { tierFilter, idFilter };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface BenchmarkReport {
  readonly timestamp: string;
  readonly model: string;
  readonly scenarioCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly results: readonly ScenarioResult[];
  readonly summary: {
    readonly overallScore: number;
    readonly toolAccuracy: number;
    readonly stepEfficiency: number;
    readonly answerQuality: number;
    readonly terminationCorrectness: number;
    readonly avgSteps: number;
    readonly avgDurationMs: number;
    readonly avgTokens: { input: number; output: number };
    readonly byTier: Record<string, { count: number; avgScore: number }>;
  };
}

async function runBenchmark(): Promise<BenchmarkReport> {
  const config = loadConfig();

  if (config.openai.apiKey === undefined) {
    console.error('ERROR: OPENAI_API_KEY is required for benchmark. Set it in .env or environment.');
    process.exit(1);
  }

  const chatLlm = new OpenAiChatLlm({
    baseUrl: config.openai.baseUrl,
    apiKey: config.openai.apiKey,
    defaultModel: config.openai.chatModel,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });

  // Minimal search use case mock for benchmark (agent calls tools which call search)
  // In benchmark mode, we run against real LLM but mock search results.
  // For full integration benchmark, wire a real container.
  const mockSearchUseCase = {
    async execute(request: { query: string }, requestId: string) {
      return {
        queryType: 'search' as const,
        engineDecision: {
          decisionStatus: 'resolved' as const,
          nextAction: 'return_result' as const,
          route: 'hybrid',
          decisionConfidence: 0.8,
          confidenceSemantics: 'calibrated_decision_confidence' as const,
          decisionTraceRef: 'bench-trace',
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1.0.0',
            threshold_profile_id: 'default-v1',
            planner_version: '1.0.0',
            feature_flags: {},
          },
        },
        results: [
          {
            entity: {
              entityId: 'wine-bench-001',
              canonicalLabel: `Result for: ${request.query.slice(0, 50)}`,
              type: 'wine',
              producer: 'Benchmark Winery',
              region: 'Test Region',
            },
            relevanceScore: 0.85,
            match: { matchType: 'hybrid' as const, scoreComponents: { lexical: 0, semantic: 0.8, attribute: 0.7, popularity: 0.5, preferenceAlignment: 0.5 } },
            constraints: { matched: [], unmet: [], inferred: [] },
            uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
            evidenceItems: [{ type: 'semantic_relevance', source: 'benchmark', contribution: '+0.80', strength: 'high' as const, provenance: 'Benchmark evidence' }],
          },
        ],
        meta: { requestId, queryTimeMs: 10, route: 'hybrid', version: '1.0.0', engine_schema_version: 'search_response_v1' },
      };
    },
  };

  const orchestrator = new AgentOrchestrator(
    {
      chatLlm,
      toolDeps: { searchUseCase: mockSearchUseCase as never },
    },
    { maxSteps: 5, agentTimeoutMs: 30_000, perStepTimeoutMs: 15_000, maxContextChars: 8_000 },
  );

  const { tierFilter, idFilter } = parseArgs();
  let scenarios: readonly AgentBenchmarkScenario[] = AGENT_SCENARIOS;
  if (tierFilter) scenarios = scenarios.filter((s) => s.tier === tierFilter);
  if (idFilter) scenarios = scenarios.filter((s) => idFilter.includes(s.id));

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    if (scenario.skip !== undefined) {
      results.push(scoreScenario(scenario, null));
      console.error(`  [SKIP] #${scenario.id} ${scenario.description}: ${scenario.skip}`);
      continue;
    }

    console.error(`  [RUN]  #${scenario.id} ${scenario.description}...`);
    const start = Date.now();

    try {
      const result = await orchestrator.execute(scenario.query, `bench-${scenario.id}`);
      const toolsUsed = result.steps
        .filter((s) => s.action !== undefined)
        .map((s) => s.action!.tool);

      const scored = scoreScenario(scenario, {
        answer: result.answer,
        stepCount: result.steps.length,
        toolCallCount: result.toolCallCount,
        toolsUsed,
        terminationReason: result.terminationReason,
        totalDurationMs: result.totalDurationMs,
        totalTokens: result.totalTokens,
      });

      results.push(scored);
      const elapsed = Date.now() - start;
      console.error(`  [DONE] #${scenario.id} score=${scored.scores.overall.toFixed(2)} steps=${scored.stepCount} ${elapsed}ms`);
    } catch (err) {
      results.push(scoreScenario(scenario, null, err instanceof Error ? err.message : String(err)));
      console.error(`  [FAIL] #${scenario.id} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  const executed = results.filter((r) => !r.skipped && r.error === undefined);
  const avgScore = (field: keyof ScenarioResult['scores']): number => {
    if (executed.length === 0) return 0;
    return executed.reduce((sum, r) => sum + r.scores[field], 0) / executed.length;
  };

  const byTier: Record<string, { count: number; avgScore: number }> = {};
  for (const r of executed) {
    const entry = byTier[r.tier] ?? { count: 0, avgScore: 0 };
    entry.count++;
    entry.avgScore += r.scores.overall;
    byTier[r.tier] = entry;
  }
  for (const tier of Object.keys(byTier)) {
    byTier[tier]!.avgScore /= byTier[tier]!.count;
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    model: config.openai.chatModel,
    scenarioCount: scenarios.length,
    executedCount: executed.length,
    skippedCount: results.filter((r) => r.skipped).length,
    results,
    summary: {
      overallScore: avgScore('overall'),
      toolAccuracy: avgScore('toolAccuracy'),
      stepEfficiency: avgScore('stepEfficiency'),
      answerQuality: avgScore('answerQuality'),
      terminationCorrectness: avgScore('terminationCorrectness'),
      avgSteps: executed.length > 0 ? executed.reduce((s, r) => s + (r.stepCount ?? 0), 0) / executed.length : 0,
      avgDurationMs: executed.length > 0 ? executed.reduce((s, r) => s + (r.totalDurationMs ?? 0), 0) / executed.length : 0,
      avgTokens: {
        input: executed.length > 0 ? executed.reduce((s, r) => s + (r.totalTokens?.input ?? 0), 0) / executed.length : 0,
        output: executed.length > 0 ? executed.reduce((s, r) => s + (r.totalTokens?.output ?? 0), 0) / executed.length : 0,
      },
      byTier,
    },
  };

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runBenchmark().then((report) => {
  // JSON to stdout (pipe to file)
  console.log(JSON.stringify(report, null, 2));

  // Summary to stderr (human-readable)
  console.error('\n══════════════════════════════════════');
  console.error('  AGENT BENCHMARK SUMMARY');
  console.error('══════════════════════════════════════');
  console.error(`  Model:       ${report.model}`);
  console.error(`  Scenarios:   ${report.scenarioCount} (${report.executedCount} executed, ${report.skippedCount} skipped)`);
  console.error(`  Overall:     ${(report.summary.overallScore * 100).toFixed(1)}%`);
  console.error(`  Tool Acc:    ${(report.summary.toolAccuracy * 100).toFixed(1)}%`);
  console.error(`  Step Eff:    ${(report.summary.stepEfficiency * 100).toFixed(1)}%`);
  console.error(`  Answer Qual: ${(report.summary.answerQuality * 100).toFixed(1)}%`);
  console.error(`  Term Corr:   ${(report.summary.terminationCorrectness * 100).toFixed(1)}%`);
  console.error(`  Avg Steps:   ${report.summary.avgSteps.toFixed(1)}`);
  console.error(`  Avg Time:    ${report.summary.avgDurationMs.toFixed(0)}ms`);
  console.error(`  Avg Tokens:  ${report.summary.avgTokens.input.toFixed(0)} in / ${report.summary.avgTokens.output.toFixed(0)} out`);
  console.error('──────────────────────────────────────');
  for (const [tier, data] of Object.entries(report.summary.byTier)) {
    console.error(`  ${tier.padEnd(22)} ${(data.avgScore * 100).toFixed(1)}% (${data.count} scenarios)`);
  }
  console.error('══════════════════════════════════════\n');
}).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
