import type { Config } from './env.js';

/**
 * Product SSOT: whether the learned LTR reranker is served on the live request
 * path. Config-gated via `LTR_SERVING_ENABLED` (default false). This is the
 * MASTER gate shared by the /v1 search Ranker and the /v2 entity-lookup reranker.
 *
 * IMPORTANT: enabling this flag only WIRES discovery in. It does not make serving
 * correct — a search-trained model fed through the /v2 lookup feature projection
 * is out-of-distribution (TRAIN-SERVE BLOCKER, inlined on the `LTR_SERVING_ENABLED`
 * schema): the bm25Score slot is trained as constant 0.0 but receives
 * normalizedAliasEvidence at serve time. Lifting the blocker requires a
 * lookup-domain-trained model whose featureSchemaHash matches, or explicit owner
 * approval. The loader/registry schema-hash check is structural only and does NOT
 * detect distribution mismatch. (The /v2 use case only wires the reranker when a
 * model is actually loaded — see container-usecases — so the OFF build runs the
 * calibrated-abstain decision alone, never the learned/lexical-fallback path.)
 */
export function isLtrServingEnabled(config: Pick<Config, 'ltrServingEnabled'>): boolean {
  return config.ltrServingEnabled;
}
