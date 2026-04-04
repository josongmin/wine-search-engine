// ── Models ���─────────────────────────────────────────────────────────────────
export type { DecisionOutput } from './model/decision-output.js';
export type {
  DecisionInput,
  AmbiguitySummary,
  EvidenceSummary,
} from './model/decision-input.js';
export type { DecisionTrace } from './model/decision-trace.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type { SnapshotStore } from './port/snapshot-store.port.js';

// ── Services ─────��──────────────────────────────��───────────────────────────
export { DecisionEngine } from './service/decision-engine.js';
export {
  EvidenceGate,
  type EvidenceGateResult,
} from './service/evidence-gate.js';
