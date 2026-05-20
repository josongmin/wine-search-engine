import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
export type RetrievalObjectiveAxis = 'occasion' | 'gift_suitability' | 'beginner_suitability' | 'value' | 'drinking_window' | 'style' | 'closure' | 'sweetness' | 'alcohol' | 'producer_prestige' | 'popularity' | 'recipient_profile' | 'presentation';
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
export declare function buildRetrievalObjective(bundle: ConstraintBundle): RetrievalObjective;
//# sourceMappingURL=retrieval-objective.d.ts.map