import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';

export type RetrievalObjectiveAxis =
  | 'occasion'
  | 'gift_suitability'
  | 'beginner_suitability'
  | 'value'
  | 'drinking_window'
  | 'style';

export type RetrievalObjectiveSourceTier = 'hard' | 'soft' | 'inferred';

export interface RetrievalObjectiveSignal {
  readonly axis: RetrievalObjectiveAxis;
  readonly attribute: string;
  readonly operator: NormalizedConstraint['operator'];
  readonly value: NormalizedConstraint['value'];
  readonly sourcePhrase: string;
  readonly confidence: number;
  readonly sourceTier: RetrievalObjectiveSourceTier;
  readonly mappingVersion?: string | undefined;
}

export interface RetrievalObjective {
  readonly signals: readonly RetrievalObjectiveSignal[];
  readonly objectiveVersion: 'retrieval-objective-v1.0';
}

const OBJECTIVE_VERSION = 'retrieval-objective-v1.0' as const;

function axisForConstraint(constraint: NormalizedConstraint): RetrievalObjectiveAxis | undefined {
  switch (constraint.attribute) {
    case 'occasion':
    case 'gift_suitability':
    case 'beginner_suitability':
    case 'drinking_window':
    case 'style':
      return constraint.attribute;
    case 'price_band':
      return 'value';
    default:
      return undefined;
  }
}

function collectSignalsFromTier(
  constraints: readonly NormalizedConstraint[],
  sourceTier: RetrievalObjectiveSourceTier,
): readonly RetrievalObjectiveSignal[] {
  return constraints.flatMap((constraint) => {
    const axis = axisForConstraint(constraint);
    if (axis === undefined) {
      return [];
    }
    return [{
      axis,
      attribute: constraint.attribute,
      operator: constraint.operator,
      value: constraint.value,
      sourcePhrase: constraint.source_phrase,
      confidence: constraint.confidence,
      sourceTier,
      ...(constraint.mapping_version !== undefined
        ? { mappingVersion: constraint.mapping_version }
        : {}),
    }];
  });
}

export function buildRetrievalObjective(bundle: ConstraintBundle): RetrievalObjective {
  return {
    signals: [
      ...collectSignalsFromTier(bundle.hard, 'hard'),
      ...collectSignalsFromTier(bundle.soft, 'soft'),
      ...collectSignalsFromTier(bundle.inferred, 'inferred'),
    ],
    objectiveVersion: OBJECTIVE_VERSION,
  };
}
