import type { GoldenQuery } from '../etl/types.js';
import { EMBEDDING_MODEL } from '../../src/domain/shared/constants/embedding.js';
import { EMBEDDING_MODEL_VERSION } from '../../src/infrastructure/ai/openai-embedding-service.js';

const EMBEDDING_SENSITIVE_QUERY_CLASSES = [
  'semantic_preference',
  'similar_compare',
  'exploration',
] as const;
const EMBEDDING_SENSITIVE_QUERY_CLASS_SET = new Set<string>(EMBEDDING_SENSITIVE_QUERY_CLASSES);

const MIN_EMBEDDING_SENSITIVE_QUERY_COUNT = 20;
const MIN_EMBEDDING_SENSITIVE_QUERY_CLASS_COUNT = 3;
const MIN_SEMANTIC_PREFERENCE_COUNT = 8;
const MIN_SIMILAR_COMPARE_COUNT = 4;
const MIN_EXPLORATION_COUNT = 4;
const MIN_LISTWISE_RELEVANT_COUNT = 3;

export interface EmbeddingSensitiveGovernanceSummary {
  readonly queryCount: number;
  readonly distinctQueryClasses: number;
  readonly queryClassMix: Readonly<Record<string, number>>;
  readonly weakListwiseGoldCount: number;
}

export interface EmbeddingSensitiveRuntimeDescriptor {
  readonly runtimeTarget: string;
  readonly usesLiveApi: boolean;
  readonly denseRetrievalEnabled?: boolean | undefined;
  readonly phase: 'dense_on' | 'dense_off';
  readonly queryEmbeddingModel: string;
  readonly queryEmbeddingModelVersion: string;
}

export function isEmbeddingSensitiveQueryClass(queryClass: string): boolean {
  return EMBEDDING_SENSITIVE_QUERY_CLASS_SET.has(queryClass);
}

export function filterEmbeddingSensitiveGoldenQueries(
  queries: readonly GoldenQuery[],
): readonly GoldenQuery[] {
  return queries.filter((query) => isEmbeddingSensitiveQueryClass(query.query_class));
}

export function summarizeEmbeddingSensitiveGovernance(
  queries: readonly GoldenQuery[],
): EmbeddingSensitiveGovernanceSummary {
  const counts = new Map<string, number>();
  let weakListwiseGoldCount = 0;
  for (const query of queries) {
    counts.set(query.query_class, (counts.get(query.query_class) ?? 0) + 1);
    if (
      (query.query_class === 'semantic_preference'
        || query.query_class === 'exploration'
        || query.query_class === 'similar_compare')
      && query.retrieval_labels.relevant.length < MIN_LISTWISE_RELEVANT_COUNT
    ) {
      weakListwiseGoldCount += 1;
    }
  }
  const queryClassMix = Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    queryCount: queries.length,
    distinctQueryClasses: counts.size,
    queryClassMix,
    weakListwiseGoldCount,
  };
}

export function assertEmbeddingSensitiveGovernance(
  queries: readonly GoldenQuery[],
): EmbeddingSensitiveGovernanceSummary {
  const summary = summarizeEmbeddingSensitiveGovernance(queries);
  const semanticPreferenceCount = summary.queryClassMix['semantic_preference'] ?? 0;
  const similarCompareCount = summary.queryClassMix['similar_compare'] ?? 0;
  const explorationCount = summary.queryClassMix['exploration'] ?? 0;
  const violations: string[] = [];
  if (summary.queryCount < MIN_EMBEDDING_SENSITIVE_QUERY_COUNT) {
    violations.push(`query_count=${summary.queryCount} < ${MIN_EMBEDDING_SENSITIVE_QUERY_COUNT}`);
  }
  if (summary.distinctQueryClasses < MIN_EMBEDDING_SENSITIVE_QUERY_CLASS_COUNT) {
    violations.push(
      `distinct_query_classes=${summary.distinctQueryClasses} < ${MIN_EMBEDDING_SENSITIVE_QUERY_CLASS_COUNT}`,
    );
  }
  if (semanticPreferenceCount < MIN_SEMANTIC_PREFERENCE_COUNT) {
    violations.push(
      `semantic_preference_count=${semanticPreferenceCount} < ${MIN_SEMANTIC_PREFERENCE_COUNT}`,
    );
  }
  if (similarCompareCount < MIN_SIMILAR_COMPARE_COUNT) {
    violations.push(
      `similar_compare_count=${similarCompareCount} < ${MIN_SIMILAR_COMPARE_COUNT}`,
    );
  }
  if (explorationCount < MIN_EXPLORATION_COUNT) {
    violations.push(`exploration_count=${explorationCount} < ${MIN_EXPLORATION_COUNT}`);
  }
  if (summary.weakListwiseGoldCount > 0) {
    violations.push(
      `weak_listwise_gold_count=${summary.weakListwiseGoldCount} > 0 `
      + `(semantic_preference/exploration/similar_compare rows require >= ${MIN_LISTWISE_RELEVANT_COUNT} relevant judgments each)`,
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `embedding-sensitive offline eval corpus governance failed: ${violations.join('; ')}`,
    );
  }
  return summary;
}

export function buildEmbeddingSensitiveRuntimeDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingSensitiveRuntimeDescriptor {
  const runtimeTarget = env['EVAL_RUNTIME_TARGET'] ?? 'search_api_http';
  const expectedDenseRetrievalEnabled = env['EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED'];
  return {
    runtimeTarget,
    usesLiveApi: runtimeTarget !== 'in_memory_test_server',
    denseRetrievalEnabled:
      expectedDenseRetrievalEnabled === 'true'
        ? true
        : expectedDenseRetrievalEnabled === 'false'
          ? false
          : runtimeTarget === 'in_memory_test_server'
            ? env['KILL_SWITCH_DENSE_RETRIEVAL'] !== 'true'
            : undefined,
    phase: env['EVAL_EMBEDDING_SENSITIVE_PHASE'] === 'dense_off' ? 'dense_off' : 'dense_on',
    queryEmbeddingModel: env['OPENAI_EMBEDDING_MODEL']?.trim() || EMBEDDING_MODEL,
    queryEmbeddingModelVersion: EMBEDDING_MODEL_VERSION,
  };
}

export function assertEmbeddingSensitiveRuntime(
  runtime: EmbeddingSensitiveRuntimeDescriptor,
): void {
  if (!runtime.usesLiveApi || runtime.runtimeTarget === 'in_memory_test_server') {
    throw new Error(
      'embedding-sensitive offline eval requires a live search runtime; in-memory surrogate targets are not allowed.',
    );
  }
  if (runtime.denseRetrievalEnabled === undefined) {
    throw new Error(
      'embedding-sensitive offline eval requires an explicit dense retrieval expectation for the live runtime. ' +
      'Set EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED=true|false from the runner that owns the target search API.',
    );
  }
  if (runtime.phase === 'dense_on' && !runtime.denseRetrievalEnabled) {
    throw new Error(
      'embedding-sensitive dense-on eval requires dense retrieval enabled; the target runtime is marked dense-off.',
    );
  }
  if (!runtime.queryEmbeddingModelVersion.startsWith(`${runtime.queryEmbeddingModel}@`)) {
    throw new Error(
      'embedding-sensitive offline eval requires the query embedding model and versioned vector namespace to match. ' +
      `model=${runtime.queryEmbeddingModel}, version=${runtime.queryEmbeddingModelVersion}`,
    );
  }
}
