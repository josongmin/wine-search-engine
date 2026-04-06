export type AdmissionOutcome = 'allow' | 'clarify' | 'reject';

export interface AdmissionSignals {
  confidence: number;
  evidenceSufficient: boolean;
  ambiguityHigh: boolean;
  routeHealthy: boolean;
  executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  blockingRequested?: boolean;
}

export function decideAdmission(signals: AdmissionSignals): AdmissionOutcome {
  if (!signals.routeHealthy) return 'reject';

  if (signals.blockingRequested === true && signals.executionMode === 'heuristic') {
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
