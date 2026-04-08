/**
 * Concrete metric collector for query-entry security events.
 *
 * Interface definitions live in domain/security/port/security-observer.port.ts
 * (hexagonal: domain port). This file provides the infrastructure implementation.
 */

import type {
  QueryEntrySecurityMetrics,
  QueryEntrySecurityObserver,
} from '../../domain/security/port/security-observer.port.js';

export class QueryEntrySecurityMetricsCollector implements QueryEntrySecurityObserver {
  private layer1Blocks = 0;
  private layer2Blocks = 0;
  private judgeErrors = 0;
  private failClosedBlocks = 0;
  private failOpenBypasses = 0;
  private lastJudgeError: { error: unknown; mode: 'fail_open' | 'fail_closed'; timestamp: number } | undefined;

  onLayer1Blocked(_reason: string): void {
    this.layer1Blocks++;
  }

  onLayer2Blocked(_reason: string): void {
    this.layer2Blocks++;
  }

  onJudgeError(error: unknown, mode: 'fail_open' | 'fail_closed'): void {
    this.judgeErrors++;
    // Store only the error message to prevent retaining large Error objects / closures.
    const message = error instanceof Error ? error.message : String(error);
    this.lastJudgeError = { error: message, mode, timestamp: Date.now() };
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
      ...(this.lastJudgeError !== undefined
        ? { lastJudgeErrorTimestamp: this.lastJudgeError.timestamp, lastJudgeErrorMode: this.lastJudgeError.mode }
        : {}),
    };
  }

  reset(): void {
    this.layer1Blocks = 0;
    this.layer2Blocks = 0;
    this.judgeErrors = 0;
    this.failClosedBlocks = 0;
    this.failOpenBypasses = 0;
    this.lastJudgeError = undefined;
  }
}

let globalCollector: QueryEntrySecurityMetricsCollector | undefined;

export function getQueryEntrySecurityMetricsCollector(): QueryEntrySecurityMetricsCollector {
  if (globalCollector === undefined) {
    globalCollector = new QueryEntrySecurityMetricsCollector();
  }

  return globalCollector;
}
