export type MetricPolicy = 'blocking' | 'advisory';
export type EvalMetricScope = 'global' | 'scenario' | 'mode' | 'entity_type';

export interface EvalMetricPolicyLookupInput {
  readonly scope: EvalMetricScope;
  readonly metric: string;
}

export interface EvalMetricViolation {
  readonly scope: EvalMetricScope;
  readonly metric: string;
  readonly message: string;
  readonly policy: MetricPolicy;
}

const ADVISORY_MODE_METRICS = new Set([
  'diversity_score',
  'producer_variety',
  'set_coverage',
  'browse_line_diversity_at_10',
  'grape_variety_at_10',
  'prestige_mean_at_10',
  'anchor_preservation_score',
  'seed_exclusion_rate',
  'attribute_coverage',
]);

const BLOCKING_GLOBAL_METRICS = [
  'ndcg_at_10',
  'mrr_at_10',
  'recall_at_3',
  'recall_at_100',
  'decision_utility',
  'wrong_top1_rate',
  'safe_abstain_rate',
  'avoidable_abstain_rate',
  'aurc',
  'e_aurc',
  'ece',
] as const;

const BLOCKING_SCENARIO_METRICS = [
  'wrong_top1_rate',
  'ndcg_at_10',
] as const;

export function getEvalMetricPolicy(input: EvalMetricPolicyLookupInput): MetricPolicy {
  if (input.scope === 'mode' || input.scope === 'entity_type') {
    return 'advisory';
  }

  if (ADVISORY_MODE_METRICS.has(input.metric)) {
    return 'advisory';
  }

  return 'blocking';
}

export function buildEvalMetricPolicySummary(): {
  readonly blocking_metrics: readonly string[];
  readonly advisory_metrics: readonly string[];
} {
  const advisoryMetrics = [...ADVISORY_MODE_METRICS].sort();
  const blockingMetrics = [
    ...BLOCKING_GLOBAL_METRICS,
    ...BLOCKING_SCENARIO_METRICS.map((metric) => `scenario:${metric}`),
  ];

  return {
    blocking_metrics: blockingMetrics,
    advisory_metrics: advisoryMetrics,
  };
}

export function createEvalMetricViolation(
  scope: EvalMetricScope,
  metric: string,
  message: string,
): EvalMetricViolation {
  return {
    scope,
    metric,
    message,
    policy: getEvalMetricPolicy({ scope, metric }),
  };
}

export function splitEvalMetricViolations(
  violations: readonly EvalMetricViolation[],
): {
  readonly blocking: readonly EvalMetricViolation[];
  readonly advisory: readonly EvalMetricViolation[];
} {
  return {
    blocking: violations.filter((violation) => violation.policy === 'blocking'),
    advisory: violations.filter((violation) => violation.policy === 'advisory'),
  };
}
