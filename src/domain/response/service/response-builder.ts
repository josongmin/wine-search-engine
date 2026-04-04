import type { DecisionOutput } from '../../decision/model/decision-output.js';
import type { EngineDecision } from '../model/engine-decision.js';
import type { ResultItem } from '../model/result-item.js';
import type { ClarificationPayload } from '../model/clarification.js';
import type { CounterfactualReject, ResponseMeta } from '../model/counterfactual.js';
import type { SearchResponseV1 } from '../model/search-response.js';

/**
 * Parameters required by {@link ResponseBuilder.build}.
 */
export interface ResponseBuildParams {
  /** Internal decision output from the Decision domain. */
  readonly decisionOutput: DecisionOutput;

  /** Ranked result items to include in the response. */
  readonly results: readonly ResultItem[];

  /** Optional clarification payload when the engine needs user input. */
  readonly clarification?: ClarificationPayload | undefined;

  /** Optional counterfactual rejects for transparency. */
  readonly counterfactuals?: readonly CounterfactualReject[] | undefined;

  /** Caller-supplied request ID for correlation. */
  readonly requestId?: string | undefined;

  /** Wall-clock query time in milliseconds. */
  readonly queryTimeMs: number;

  /** Execution route label. */
  readonly route: string;

  /** Response format version (defaults to "1.0.0"). */
  readonly version?: string | undefined;
}

/** Reason code attached when a result has no evidence items. */
const NO_EVIDENCE_REASON = 'no_evidence_available';

/**
 * Assembles a complete {@link SearchResponseV1} from domain outputs.
 *
 * Responsibilities:
 * - Maps the internal {@link DecisionOutput} to the external {@link EngineDecision}.
 * - Enforces the invariant that every result carries evidence items (or a reason code).
 * - Attaches response-level metadata.
 */
export class ResponseBuilder {
  /**
   * Build a {@link SearchResponseV1} from the given parameters.
   *
   * @param params - All inputs required to assemble the response.
   * @returns A fully assembled, immutable search response.
   */
  build(params: ResponseBuildParams): SearchResponseV1 {
    const engineDecision = this.mapDecision(params.decisionOutput, params.route);
    const validatedResults = this.enforceEvidence(params.results);

    const meta: ResponseMeta = {
      requestId: params.requestId,
      queryTimeMs: params.queryTimeMs,
      route: params.route,
      version: params.version ?? '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: params.decisionOutput.decisionSnapshot,
    };

    return {
      engineDecision,
      results: validatedResults,
      counterfactuals: params.counterfactuals,
      clarification: params.clarification ?? null,
      meta,
    };
  }

  /**
   * Map internal {@link DecisionOutput} to the external-facing {@link EngineDecision}.
   */
  private mapDecision(output: DecisionOutput, route: string): EngineDecision {
    return {
      decisionStatus: output.decisionStatus,
      nextAction: output.nextAction,
      route,
      decisionConfidence: output.decisionConfidence,
      confidenceSemantics: output.confidenceSemantics,
      decisionTraceRef: output.decisionTraceRef,
      decisionSnapshot: output.decisionSnapshot,
    };
  }

  /**
   * Enforce the invariant that every result must carry at least one evidence item.
   * Results without evidence receive a synthetic evidence item with a reason code.
   */
  private enforceEvidence(results: readonly ResultItem[]): readonly ResultItem[] {
    return results.map((result) => {
      if (result.evidenceItems.length > 0) {
        return result;
      }

      return {
        ...result,
        evidenceItems: [
          {
            type: NO_EVIDENCE_REASON,
            source: 'response_builder',
            contribution: '+0.00',
            strength: 'low' as const,
            provenance: 'No evidence was produced by upstream stages for this result.',
          },
        ],
      };
    });
  }
}
