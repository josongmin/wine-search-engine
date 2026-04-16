import type {
  EvalBenchmarkKind,
  EvalBenchmarkRun,
  EvalBenchmarkRunInput,
} from '../model/eval-benchmark-run.js';

export interface EvalBenchmarkRunFilter {
  readonly benchmarkKind?: EvalBenchmarkKind;
  readonly snapshotId?: string;
  readonly since?: Date;
  readonly limit?: number;
}

export interface EvalBenchmarkRunStore {
  saveRun(run: EvalBenchmarkRunInput): Promise<string>;
  listRuns(filter?: EvalBenchmarkRunFilter): Promise<readonly EvalBenchmarkRun[]>;
}
