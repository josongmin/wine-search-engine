/**
 * Adapter: agent benchmark scenario → claim-level evaluator (RFC-020).
 *
 * Bridges the test/benchmark/agent format to the domain evaluator,
 * inferring TaskType from scenario tier.
 */

import type { ChatLlmPort } from '../../../src/domain/ai/port/chat-llm.port.js';
import type { DiagnosticVector, TaskType } from '../../../src/domain/evaluation/model/claim.js';
import { evaluateClaims } from '../../../src/domain/evaluation/service/claim-level-evaluator.js';
import { buildEvidenceRecordsFromFrames } from '../../../src/domain/evaluation/service/build-evidence-records-from-frames.js';
import { parseObservations } from '../../../src/domain/evaluation/service/evidence-parser.js';
import type { AgentBenchmarkScenario, ScenarioTier } from './scenario.js';
import type { ScenarioExecution } from './scorer.js';

/**
 * Evaluate a scenario execution at claim level.
 *
 * @param scenario - Benchmark scenario
 * @param execution - Agent execution result
 * @param llm - LLM port for semantic verification (null = deterministic only)
 */
export async function evaluateScenarioClaims(
  scenario: AgentBenchmarkScenario,
  execution: ScenarioExecution,
  llm: ChatLlmPort | null,
): Promise<DiagnosticVector> {
  const frameEvidenceRecords = execution.evidenceFrames !== undefined
    ? buildEvidenceRecordsFromFrames(execution.evidenceFrames)
    : [];
  const evidenceRecords = frameEvidenceRecords.length > 0
    ? frameEvidenceRecords
    : parseObservations(execution.observations);
  const evidenceContext = execution.observations.join('\n\n');
  const taskType = inferTaskType(scenario.tier);

  return evaluateClaims(execution.answer, evidenceRecords, evidenceContext, taskType, llm);
}

/**
 * Map scenario tier → task type for hard-fail policy selection.
 */
function inferTaskType(tier: ScenarioTier): TaskType {
  switch (tier) {
    // Single specific wine
    case 'wine_name_lookup':
    case 'single_shot':
    case 'edge_case':
    case 'adversarial':
      return 'single_recommendation';

    // Multi-result browse / list
    case 'multi_step':
    case 'complex_reasoning':
    case 'mood_atmosphere':
    case 'gift_refined':
    case 'situation_based':
    case 'korean_food_pairing':
    case 'wine_type_basic':
    case 'taste_descriptor':
    case 'rating_score':
    case 'cellar_aging':
      return 'multi_recommendation';

    // Wine-vs-wine comparison
    case 'comparison_nested':
    case 'relative_reference':
      return 'comparison_query';

    // General/educational queries (no hard-fail on identity)
    case 'conversational':
    case 'nested_condition':
    case 'negation':
    case 'negation_complex':
    case 'knowledge_hybrid':
    case 'extreme':
    case 'korean_colloquial':
    case 'price_expression':
    case 'seasonal_temporal':
    case 'arithmetic_query':
    case 'bilingual_mixed':
      return 'general_query';
  }
  // Exhaustiveness check — adding a new ScenarioTier without updating this switch
  // will produce a compile error here.
  const _exhaustive: never = tier;
  return _exhaustive;
}
