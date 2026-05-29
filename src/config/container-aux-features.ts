import type { Pool } from 'pg';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import { PgGoldSetStore } from '../infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../infrastructure/adapter/pg-eval-result-store.js';
import { SearchPipelineEvaluator } from '../infrastructure/adapter/search-pipeline-evaluator.js';
import type { UseCaseContainerServices } from './container-usecases.js';

export function buildEvalRunner(
  pool: Pool | undefined,
  searchUseCase: UseCaseContainerServices['searchUseCase'],
): EvalRunner | null {
  if (!pool) {
    bootstrapLogger.warn(
      '[Container] Evaluation infrastructure skipped (Postgres pool not available)',
    );
    return null;
  }

  bootstrapLogger.warn('[Container] Evaluation infrastructure initialized');
  return new EvalRunner(
    new PgGoldSetStore(pool),
    new PgEvalResultStore(pool),
    new SearchPipelineEvaluator(searchUseCase),
  );
}
