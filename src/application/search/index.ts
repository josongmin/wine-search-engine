/**
 * Application-layer search surface (use cases, DTOs).
 * New code may use `import { SearchUseCase } from '@app/search/index.js'`; existing deep imports remain valid.
 */
export { SearchUseCase } from './search.usecase.js';
export type { SearchUseCaseDeps, SnapshotVersions } from './search.usecase.js';

export type { SearchRequest } from './search-request.dto.js';

export { BatchSearchUseCase } from './batch-search.usecase.js';
export { DecomposedSearchUseCase } from './decomposed-search.usecase.js';
export { HybridUseCase } from './hybrid.usecase.js';
export { InterpretUseCase } from './interpret.usecase.js';
export { ReplayUseCase } from './replay.usecase.js';
export { ResolveUseCase } from './resolve.usecase.js';
