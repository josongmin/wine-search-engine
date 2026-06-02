import type { Config } from './env.js';

/**
 * Product SSOT: whether the learned LTR reranker is served on the live request
 * path. Config-gated via `LTR_SERVING_ENABLED` (default false). This is the
 * MASTER gate shared by the /v1 search Ranker and the /v2 entity-lookup reranker.
 *
 * IMPORTANT: enabling this flag only WIRES the model in. It does not make serving
 * correct — a search-trained model fed through the /v2 lookup feature projection
 * is out-of-distribution. Activation is additionally guarded by the train-serve
 * blocker documented on the `LTR_SERVING_ENABLED` schema (T-ELV2-05 runbook):
 * use a lookup-domain-trained model whose featureSchemaHash matches, or obtain
 * explicit owner approval. The loader/registry schema-hash check is structural
 * only and does NOT detect distribution mismatch.
 */
export function isLtrServingEnabled(config: Pick<Config, 'ltrServingEnabled'>): boolean {
  return config.ltrServingEnabled;
}
