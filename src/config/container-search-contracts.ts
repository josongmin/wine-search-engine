import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ReplayUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';

export type SearchUseCaseContract = SearchExecutorPort;
export type ReplayUseCaseContract = ReplayUseCasePort;
export type InterpretUseCaseContract = InterpretUseCasePort;
export type ResolveUseCaseContract = ResolveUseCasePort;
export type HybridUseCaseContract = HybridUseCasePort;
export type DecomposedSearchUseCaseContract = DecomposedSearchUseCasePort;
export type BatchSearchUseCaseContract = BatchSearchUseCasePort;
