import type { GoldSetFilter, EvalReport } from '../domain/evaluation/index.js';

export interface EvalRunnerContract {
  run(filter?: GoldSetFilter): Promise<EvalReport>;
}
