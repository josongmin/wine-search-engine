export type AdmissionOutcome = 'allow' | 'clarify' | 'reject';

export interface AdmissionSignals {
  confidence: number;
  evidenceSufficient: boolean;
  ambiguityHigh: boolean;
  routeHealthy: boolean;
  executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  effectiveRetrievalMode?: string;
  blockingRequested?: boolean;
}

function isBlockingSensitiveExploratoryMode(
  effectiveRetrievalMode: string | undefined,
): boolean {
  switch (effectiveRetrievalMode) {
    case 'compare_candidates':
    case 'recommendation':
    case 'similar_items':
    case 'producer_browse':
    case 'region_browse':
      return true;
    default:
      return false;
  }
}

export function decideAdmission(signals: AdmissionSignals): AdmissionOutcome {
  if (!signals.routeHealthy) return 'reject';

  if (signals.blockingRequested === true && signals.executionMode === 'heuristic') {
    return 'reject';
  }

  // Compiled-first execution modes can signal exploratory retrieval contracts
  // that should not produce blocking answers unless the runtime stayed fully
  // authoritative. This keeps degraded/advisory recommendation or comparison
  // flows from surfacing as binding decisions when the caller requested a
  // blocking response.
  if (
    signals.blockingRequested === true &&
    signals.executionMode !== 'authoritative' &&
    isBlockingSensitiveExploratoryMode(signals.effectiveRetrievalMode)
  ) {
    return 'reject';
  }

  if (signals.ambiguityHigh) {
    return 'clarify';
  }

  if (!signals.evidenceSufficient) {
    return 'clarify';
  }

  // Confidence floors are enforced by optional ConfidenceRefusalPolicy when injected;
  // avoid duplicating that here so legacy "no policy" paths stay backward compatible.

  return 'allow';
}
