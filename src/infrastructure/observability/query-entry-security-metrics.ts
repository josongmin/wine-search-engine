export interface QueryEntrySecurityMetrics {
  readonly layer1Blocks: number;
  readonly layer2Blocks: number;
  readonly judgeErrors: number;
  readonly failClosedBlocks: number;
  readonly failOpenBypasses: number;
}

export interface QueryEntrySecurityObserver {
  onLayer1Blocked(reason: string): void;
  onLayer2Blocked(reason: string): void;
  onJudgeError(error: unknown, mode: 'fail_open' | 'fail_closed'): void;
  onFailClosedBlock(): void;
  onFailOpenBypass(): void;
}

export class QueryEntrySecurityMetricsCollector implements QueryEntrySecurityObserver {
  private layer1Blocks = 0;
  private layer2Blocks = 0;
  private judgeErrors = 0;
  private failClosedBlocks = 0;
  private failOpenBypasses = 0;

  onLayer1Blocked(_reason: string): void {
    this.layer1Blocks++;
  }

  onLayer2Blocked(_reason: string): void {
    this.layer2Blocks++;
  }

  onJudgeError(_error: unknown, _mode: 'fail_open' | 'fail_closed'): void {
    this.judgeErrors++;
  }

  onFailClosedBlock(): void {
    this.failClosedBlocks++;
  }

  onFailOpenBypass(): void {
    this.failOpenBypasses++;
  }

  getMetrics(): QueryEntrySecurityMetrics {
    return {
      layer1Blocks: this.layer1Blocks,
      layer2Blocks: this.layer2Blocks,
      judgeErrors: this.judgeErrors,
      failClosedBlocks: this.failClosedBlocks,
      failOpenBypasses: this.failOpenBypasses,
    };
  }

  reset(): void {
    this.layer1Blocks = 0;
    this.layer2Blocks = 0;
    this.judgeErrors = 0;
    this.failClosedBlocks = 0;
    this.failOpenBypasses = 0;
  }
}

let globalCollector: QueryEntrySecurityMetricsCollector | undefined;

export function getQueryEntrySecurityMetricsCollector(): QueryEntrySecurityMetricsCollector {
  if (globalCollector === undefined) {
    globalCollector = new QueryEntrySecurityMetricsCollector();
  }

  return globalCollector;
}
