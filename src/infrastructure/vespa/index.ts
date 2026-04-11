/**
 * Barrel exports for the Vespa infrastructure adapter.
 */

export { VespaClient } from './vespa-client.js';
export type {
  VespaHit,
  VespaQueryResponse,
  BulkFeedResult,
} from './vespa-client.js';

export { VespaSearchIndex } from './vespa-search-index.js';

export { HttpEmbeddingService } from './embedding-service.js';

export {
  toVespaFields,
  fromVespaFields,
  buildSparseFilters,
  buildDenseFilters,
  buildNumericRangeFilters,
} from './mapping.js';
