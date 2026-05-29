#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';
import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import { loadRelevanceJudgments } from '../../src/domain/evaluation/service/relevance-judgment-loader.js';
import { assertEmbeddingSensitiveGovernance } from './embedding-sensitive-offline-eval.js';
import { inferGoldenQueryLanguage } from './golden-query-corpus-contract.js';
import type {
  GoldenQuery,
  GoldenQueryClass,
  RelevanceJudgment,
  Scenario,
} from '../etl/types.js';

const DEFAULT_JUDGMENTS_PATH = path.resolve(process.cwd(), 'data/gold-relevance-judgments.jsonl');
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data/embedding-sensitive-human-gold.snapshot.jsonl');
const EMBEDDING_SENSITIVE_HUMAN_GOLD_RUN_ID = 'embedding-sensitive-human-gold-v1';
const MIN_RELEVANT_GRADE = 2;
const MIN_LISTWISE_RELEVANT_COUNT = 3;

type EmbeddingSensitiveHumanGoldClass =
  | 'semantic_preference'
  | 'exploration'
  | 'similar_compare';

const EMBEDDING_SENSITIVE_HUMAN_GOLD_SCENARIO_IDS: Readonly<
  Record<EmbeddingSensitiveHumanGoldClass, readonly number[]>
> = {
  semantic_preference: [
    2, 6, 8, 12, 25, 26, 27, 29, 45, 46, 48,
  ],
  exploration: [
    3, 10, 13, 19, 40, 41, 42, 44,
  ],
  similar_compare: [
    4, 7, 9, 30, 31, 32, 34, 35, 51,
  ],
};

const QUERY_CLASS_TO_SCENARIO: Readonly<Record<EmbeddingSensitiveHumanGoldClass, Scenario>> = {
  semantic_preference: 'C',
  exploration: 'E',
  similar_compare: 'F',
};

interface CliArgs {
  readonly judgmentsPath: string;
  readonly outputPath: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let judgmentsPath = DEFAULT_JUDGMENTS_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--judgments' || arg === '--input') {
      judgmentsPath = argv[index + 1] ?? DEFAULT_JUDGMENTS_PATH;
      index += 1;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      outputPath = argv[index + 1] ?? DEFAULT_OUTPUT_PATH;
      index += 1;
    }
  }
  return { judgmentsPath, outputPath };
}

function makeQid(queryClass: EmbeddingSensitiveHumanGoldClass, scenarioId: number): string {
  const family =
    queryClass === 'semantic_preference'
      ? 'c'
      : queryClass === 'exploration'
        ? 'e'
        : 'f';
  return `q-${family}-hg-${String(scenarioId).padStart(4, '0')}`;
}

function uniqueScenarioIds(): readonly number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const scenarioIds of Object.values(EMBEDDING_SENSITIVE_HUMAN_GOLD_SCENARIO_IDS)) {
    for (const scenarioId of scenarioIds) {
      if (seen.has(scenarioId)) {
        throw new Error(
          `embedding-sensitive human-gold scenario selection duplicates scenario-${scenarioId}`,
        );
      }
      seen.add(scenarioId);
      ordered.push(scenarioId);
    }
  }
  return ordered;
}

function buildScenarioLookup(
  scenarios: readonly AgentBenchmarkScenario[],
): ReadonlyMap<number, AgentBenchmarkScenario> {
  const lookup = new Map<number, AgentBenchmarkScenario>();
  for (const scenario of scenarios) {
    lookup.set(scenario.id, scenario);
  }
  return lookup;
}

function toEvalRelevanceJudgments(
  judgments: readonly {
    readonly entityId: string;
    readonly grade: 0 | 1 | 2 | 3;
  }[],
): readonly RelevanceJudgment[] {
  return [...judgments]
    .sort((left, right) => right.grade - left.grade || left.entityId.localeCompare(right.entityId))
    .map((judgment) => ({
      entity_id: judgment.entityId,
      grade: judgment.grade,
    }));
}

function buildGoldenQuery(args: {
  readonly queryClass: EmbeddingSensitiveHumanGoldClass;
  readonly scenario: AgentBenchmarkScenario;
  readonly judgments: readonly {
    readonly entityId: string;
    readonly grade: 0 | 1 | 2 | 3;
    readonly auditedAt?: number | undefined;
  }[];
}): GoldenQuery {
  const relevant = toEvalRelevanceJudgments(args.judgments);
  const highTrustRelevant = relevant.filter((judgment) => judgment.grade >= MIN_RELEVANT_GRADE);
  if (highTrustRelevant.length < MIN_LISTWISE_RELEVANT_COUNT) {
    throw new Error(
      `embedding-sensitive human-gold scenario-${args.scenario.id} has only ${highTrustRelevant.length} relevant judgments >= grade ${MIN_RELEVANT_GRADE}; minimum ${MIN_LISTWISE_RELEVANT_COUNT} required`,
    );
  }

  const leakageEntityId = highTrustRelevant[0]?.entity_id ?? relevant[0]?.entity_id;
  if (leakageEntityId === undefined) {
    throw new Error(`embedding-sensitive human-gold scenario-${args.scenario.id} has no judgments`);
  }

  const auditedAt = args.judgments
    .map((judgment) => judgment.auditedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const createdAt = auditedAt.length > 0
    ? new Date(Math.max(...auditedAt)).toISOString()
    : '2026-01-01T00:00:00.000Z';

  return {
    qid: makeQid(args.queryClass, args.scenario.id),
    query: args.scenario.query,
    query_class: args.queryClass as GoldenQueryClass,
    scenario: QUERY_CLASS_TO_SCENARIO[args.queryClass],
    language: inferGoldenQueryLanguage(args.scenario.query),
    retrieval_labels: { relevant },
    decision_labels: {
      expected_decision_status: 'resolved',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: leakageEntityId,
      query_template_id: `embedding_sensitive_human_gold_${args.queryClass}_v1`,
      generation_run_id: EMBEDDING_SENSITIVE_HUMAN_GOLD_RUN_ID,
      alias_cluster_id: `human-gold-scenario-${args.scenario.id}`,
    },
    annotation_tier: 'gate',
    annotated_by: [`human_gold:scenario-${args.scenario.id}`],
    release_gate_eligible: false,
    created_at: createdAt,
  };
}

export async function buildEmbeddingSensitiveHumanGoldCorpus(args: {
  readonly judgmentsPath?: string | undefined;
  readonly scenarios?: readonly AgentBenchmarkScenario[] | undefined;
} = {}): Promise<readonly GoldenQuery[]> {
  uniqueScenarioIds();
  const judgments = await loadRelevanceJudgments(args.judgmentsPath ?? DEFAULT_JUDGMENTS_PATH);
  const scenarios = args.scenarios ?? AGENT_SCENARIOS;
  const scenarioLookup = buildScenarioLookup(scenarios);
  const judgmentsByQueryId = new Map<string, typeof judgments>();

  for (const judgment of judgments) {
    const existing = judgmentsByQueryId.get(judgment.queryId);
    if (existing === undefined) {
      judgmentsByQueryId.set(judgment.queryId, [judgment]);
      continue;
    }
    judgmentsByQueryId.set(judgment.queryId, [...existing, judgment]);
  }

  const queries: GoldenQuery[] = [];
  for (const [queryClass, scenarioIds] of Object.entries(
    EMBEDDING_SENSITIVE_HUMAN_GOLD_SCENARIO_IDS,
  ) as [EmbeddingSensitiveHumanGoldClass, readonly number[]][]) {
    for (const scenarioId of scenarioIds) {
      const scenario = scenarioLookup.get(scenarioId);
      if (scenario === undefined) {
        throw new Error(
          `embedding-sensitive human-gold scenario-${scenarioId} is missing from AGENT_SCENARIOS`,
        );
      }
      const queryId = `scenario-${scenarioId}`;
      const scenarioJudgments = judgmentsByQueryId.get(queryId) ?? [];
      if (scenarioJudgments.length === 0) {
        throw new Error(
          `embedding-sensitive human-gold scenario-${scenarioId} is missing from ${args.judgmentsPath ?? DEFAULT_JUDGMENTS_PATH}`,
        );
      }
      queries.push(buildGoldenQuery({
        queryClass,
        scenario,
        judgments: scenarioJudgments.map((judgment) => ({
          entityId: judgment.entityId,
          grade: judgment.grade,
          auditedAt: judgment.auditedAt,
        })),
      }));
    }
  }

  assertEmbeddingSensitiveGovernance(queries);
  return queries;
}

export async function writeEmbeddingSensitiveHumanGoldCorpus(args: {
  readonly outputPath: string;
  readonly judgmentsPath?: string | undefined;
}): Promise<readonly GoldenQuery[]> {
  const queries = await buildEmbeddingSensitiveHumanGoldCorpus({
    judgmentsPath: args.judgmentsPath,
  });
  const lines = queries.map((query) => JSON.stringify(query)).join('\n');
  await fs.writeFile(args.outputPath, `${lines}\n`, 'utf8');
  return queries;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const queries = await writeEmbeddingSensitiveHumanGoldCorpus({
    outputPath: args.outputPath,
    judgmentsPath: args.judgmentsPath,
  });
  process.stdout.write(
    `embedding-sensitive human-gold corpus written: ${queries.length} queries -> ${args.outputPath}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
