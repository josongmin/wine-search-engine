import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SynthesisContext, ToolOutcome } from './tool-outcome.js';

export interface AgentExecutionState {
  readonly steps: AgentStep[];
  readonly toolOutcomes: ToolOutcome[];
  readonly collectedFrames: ToolCallEvidenceFrame[];
  lastSearchResult: SearchResponseV1 | undefined;
  terminationReason: AgentTerminationReason;
  totalInputTokens: number;
  totalOutputTokens: number;
  reasoningFailureDetected: boolean;
  policyBlocked: boolean;
  llmCircuitOpen: boolean;
  unknownToolAttempts: number;
  timeoutStats: { llmStep: number; tool: number; parallelBatch: number };
  hasInjectedRefinementHint: boolean;
  pendingRefinementHint: string | undefined;
  fallbackApplied: boolean;
  fallbackLayer: SynthesisContext['fallbackApplied'];
  failedSynthesisAttempts: number;
  fallbackSearchUsed: boolean;
  answer: string;
}

export function createAgentExecutionState(): AgentExecutionState {
  return {
    steps: [],
    toolOutcomes: [],
    collectedFrames: [],
    lastSearchResult: undefined,
    terminationReason: 'max_steps',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reasoningFailureDetected: false,
    policyBlocked: false,
    llmCircuitOpen: false,
    unknownToolAttempts: 0,
    timeoutStats: { llmStep: 0, tool: 0, parallelBatch: 0 },
    hasInjectedRefinementHint: false,
    pendingRefinementHint: undefined,
    fallbackApplied: false,
    fallbackLayer: null,
    failedSynthesisAttempts: 0,
    fallbackSearchUsed: false,
    answer: '',
  };
}
