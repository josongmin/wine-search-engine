export interface WineSearchRunInput {
  readonly query: string;
  readonly maxSteps?: number | undefined;
  readonly perStepTimeoutMs?: number | undefined;
  readonly agentTimeoutMs?: number | undefined;
  readonly maxTotalTokens?: number | undefined;
}

export type WineSearchRunResult = unknown;
