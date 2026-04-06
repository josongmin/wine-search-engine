import type { Pool } from 'pg';
import { bootstrapLogger } from './bootstrap-logger.js';
import { WineToolExecutor } from '../interface/claude-tools/tool-executor.js';
import { AdaptiveToolExecutor } from '../interface/claude-tools/adaptive-tool-executor.js';
import { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import { PgGoldSetStore } from '../infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../infrastructure/adapter/pg-eval-result-store.js';
import { SearchPipelineEvaluator } from '../infrastructure/adapter/search-pipeline-evaluator.js';
import type { AdaptiveToolExecutorContract } from './container-tool-contracts.js';
import type { UseCaseContainerServices } from './container-usecases.js';

export function buildAdaptiveToolExecutor(
  useCases: Pick<
    UseCaseContainerServices,
    'searchUseCase' | 'decomposedSearchUseCase' | 'drinkingWindowUseCase'
  >,
): AdaptiveToolExecutorContract {
  return new AdaptiveToolExecutor(
    new WineToolExecutor({
      searchUseCase: useCases.searchUseCase,
      decomposedSearchUseCase: useCases.decomposedSearchUseCase,
      drinkingWindowUseCase: useCases.drinkingWindowUseCase,
    }),
  );
}

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
