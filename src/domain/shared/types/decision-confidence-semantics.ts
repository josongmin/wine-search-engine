export const DECISION_CONFIDENCE_SEMANTICS = [
  'calibrated_decision_confidence',
  'uncalibrated_decision_score',
] as const;

export type DecisionConfidenceSemantics =
  (typeof DECISION_CONFIDENCE_SEMANTICS)[number];

export function deriveDecisionConfidenceSemantics(
  calibrationTrusted: boolean,
): DecisionConfidenceSemantics {
  return calibrationTrusted
    ? 'calibrated_decision_confidence'
    : 'uncalibrated_decision_score';
}
