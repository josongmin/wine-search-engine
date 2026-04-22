import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';

export type RetrievalObjectiveAxis =
  | 'occasion'
  | 'gift_suitability'
  | 'beginner_suitability'
  | 'value'
  | 'drinking_window'
  | 'style'
  | 'closure'
  | 'sweetness'
  | 'alcohol'
  | 'producer_prestige'
  | 'presentation';

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

function stringValues(value: NormalizedConstraint['value']): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function axesForConstraint(constraint: NormalizedConstraint): readonly RetrievalObjectiveAxis[] {
  switch (constraint.attribute) {
    case 'occasion':
    case 'gift_suitability':
    case 'beginner_suitability':
    case 'drinking_window':
    case 'sweetness':
    case 'closure':
    case 'producer_prestige':
      return [constraint.attribute];
    case 'style': {
      const values = stringValues(constraint.value);
      const hasPresentation = values.includes('presentation_forward');
      const hasNonPresentationStyle = values.some((value) => value !== 'presentation_forward');
      if (hasPresentation && hasNonPresentationStyle) {
        return ['style', 'presentation'];
      }
      return hasPresentation ? ['presentation'] : ['style'];
    }
    case 'alcohol':
    case 'alcohol_pct':
      return ['alcohol'];
    case 'price_band':
      return ['value'];
    default:
      return [];
  }
}

function collectSignalsFromTier(
  constraints: readonly NormalizedConstraint[],
  sourceTier: RetrievalObjectiveSourceTier,
): readonly RetrievalObjectiveSignal[] {
  return constraints.flatMap((constraint) => {
    const axes = axesForConstraint(constraint);
    return axes.map((axis) => ({
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
    }));
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
