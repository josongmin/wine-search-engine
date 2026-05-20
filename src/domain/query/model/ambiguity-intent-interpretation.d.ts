import type { QueryClass } from '../../shared/types/query-class.js';
export interface AmbiguityBranchSelection {
    readonly surface: string;
    readonly entityType: string;
    readonly decision: 'preserve_ambiguity' | 'select_branches';
    readonly selectedBranchLabels: readonly string[];
    readonly resolvedQueryClass?: QueryClass | undefined;
    readonly clarifyQuestion?: string | undefined;
    readonly confidence: number;
}
export interface AmbiguityIntentInterpretation {
    readonly source: 'llm_intent_compiler';
    readonly compilerVersion: string;
    readonly branchSelections: readonly AmbiguityBranchSelection[];
}
export interface AmbiguityIntentTrace {
    readonly source: 'not_applicable' | 'llm_intent_compiler' | 'llm_intent_compiler_empty' | 'llm_intent_compiler_invalid' | 'llm_intent_compiler_error';
    readonly compilerVersion?: string | undefined;
    readonly latencyMs: number | null;
    readonly branchSelectionCount: number;
    readonly selectedBranchCount: number;
    readonly queryClassOverride?: QueryClass | undefined;
}
//# sourceMappingURL=ambiguity-intent-interpretation.d.ts.map