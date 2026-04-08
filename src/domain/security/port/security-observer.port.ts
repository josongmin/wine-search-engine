/**
 * Domain port for query-entry security observation.
 *
 * Previously in infrastructure/observability — moved here to fix
 * the hexagonal architecture violation (application → infrastructure dependency).
 * Concrete metric collectors implement this in infrastructure/.
 */

export interface QueryEntrySecurityMetrics {
  readonly layer1Blocks: number;
  readonly layer2Blocks: number;
  readonly judgeErrors: number;
  readonly failClosedBlocks: number;
  readonly failOpenBypasses: number;
  readonly lastJudgeErrorTimestamp?: number;
  readonly lastJudgeErrorMode?: 'fail_open' | 'fail_closed';
}

export interface QueryEntrySecurityObserver {
  onLayer1Blocked(reason: string): void;
  onLayer2Blocked(reason: string): void;
  onJudgeError(error: unknown, mode: 'fail_open' | 'fail_closed'): void;
  onFailClosedBlock(): void;
  onFailOpenBypass(): void;
}
