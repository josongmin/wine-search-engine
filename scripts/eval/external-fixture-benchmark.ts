import type { BenchmarkCase, SuiteId } from '../../src/infrastructure/fixture/fixture-loader.js';
import { FixtureLoader } from '../../src/infrastructure/fixture/fixture-loader.js';

export const ENTITY_RETRIEVAL_SUITE_IDS = [
  'exact_entity_recovery',
  'ambiguous_shortform',
  'mixed_script_entity',
  'noisy_attribute_recovery',
] as const satisfies readonly SuiteId[];

export const AGENTIC_SUITE_IDS = [
  'agentic_tool_use',
  'agentic_answer_quality',
] as const satisfies readonly SuiteId[];

export type EntityRetrievalSuiteId = (typeof ENTITY_RETRIEVAL_SUITE_IDS)[number];
export type AgenticSuiteId = (typeof AGENTIC_SUITE_IDS)[number];

export interface FixtureEntityBenchmarkCase {
  readonly benchmark_id: string;
  readonly suite: EntityRetrievalSuiteId;
  readonly query: string;
  readonly expected_entity_id: string;
  readonly category: string;
  readonly language: 'ko' | 'en' | 'mixed';
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly top_k: number;
  readonly clarify_acceptable: boolean;
  readonly confident_wrong_top1_forbidden: boolean;
  readonly expected_resolution?: 'resolved' | 'ambiguous' | 'failed';
  readonly expected_provenance_stage?: string;
  readonly expected_provenance_source?: string;
}

export function parseSuiteIdList<TSuiteId extends string>(
  raw: string | undefined,
  allowed: readonly TSuiteId[],
): readonly TSuiteId[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is TSuiteId => allowed.includes(part as TSuiteId));
  return parsed.length > 0 ? parsed : undefined;
}

export function createFixtureLoader(repoPath?: string): FixtureLoader {
  return new FixtureLoader(repoPath);
}

export async function loadFixtureCases(
  suiteIds: readonly SuiteId[],
  repoPath?: string,
): Promise<readonly BenchmarkCase[]> {
  const loader = createFixtureLoader(repoPath);
  if (!loader.isAvailable()) {
    throw new Error(
      'External fixture repository is unavailable. Set FIXTURE_REPO_PATH or clone wine-engine-fixture next to the engine repo.',
    );
  }

  const cases = await Promise.all(suiteIds.map(async (suiteId) => loader.loadCases(suiteId)));
  return cases.flat();
}

export async function loadFixtureThresholds(
  repoPath?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const loader = createFixtureLoader(repoPath);
  if (!loader.isAvailable()) {
    throw new Error(
      'External fixture repository is unavailable. Set FIXTURE_REPO_PATH or clone wine-engine-fixture next to the engine repo.',
    );
  }
  return loader.loadThresholds();
}

export function mapFixtureCaseToEntityBenchmarkCase(
  benchmarkCase: BenchmarkCase,
): FixtureEntityBenchmarkCase {
  const targetEntityId = benchmarkCase.evaluation.target_entity_id;
  if (targetEntityId === undefined) {
    throw new Error(`Fixture case ${benchmarkCase.id} is missing evaluation.target_entity_id`);
  }

  const clarifyAcceptable = benchmarkCase.evaluation.clarify_acceptable ?? false;
  const topK = benchmarkCase.evaluation.top_k ?? 1;
  const expectedResolution =
    benchmarkCase.evaluation.mode === 'clarify_allowed' && clarifyAcceptable
      ? 'ambiguous'
      : 'resolved';

  return {
    benchmark_id: benchmarkCase.id,
    suite: benchmarkCase.suite as EntityRetrievalSuiteId,
    query: benchmarkCase.query,
    expected_entity_id: targetEntityId,
    category: benchmarkCase.category,
    language: benchmarkCase.language,
    difficulty: benchmarkCase.difficulty,
    top_k: topK,
    clarify_acceptable: clarifyAcceptable,
    confident_wrong_top1_forbidden: benchmarkCase.evaluation.confident_wrong_top1_forbidden ?? false,
    expected_resolution: expectedResolution,
    expected_provenance_stage: benchmarkCase.provenance?.expected_stage,
    expected_provenance_source: benchmarkCase.provenance?.expected_source,
  };
}

export async function loadEntityRetrievalFixtureCases(
  suiteIds: readonly EntityRetrievalSuiteId[],
  repoPath?: string,
): Promise<readonly FixtureEntityBenchmarkCase[]> {
  const cases = await loadFixtureCases(suiteIds, repoPath);
  return cases.map(mapFixtureCaseToEntityBenchmarkCase);
}

export function readNumericThreshold(
  suiteThresholds: Readonly<Record<string, unknown>>,
  metric: string,
): number | undefined {
  const metricDef = suiteThresholds[metric];
  if (typeof metricDef !== 'object' || metricDef === null) return undefined;
  const value = (metricDef as Record<string, unknown>)['value'];
  return typeof value === 'number' ? value : undefined;
}
