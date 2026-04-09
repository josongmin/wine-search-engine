import { z } from 'zod';

/**
 * Vespa search backend connection and per-operation timeouts.
 */

/** Vespa search API request timeout (aligned with previous VespaClient default). */
const DEFAULT_VESPA_SEARCH_REQUEST_TIMEOUT_MS = 30_000;
/** Vespa document POST/PUT mutation timeout. */
const DEFAULT_VESPA_DOCUMENT_MUTATION_TIMEOUT_MS = 15_000;
/** Vespa document GET/DELETE timeout. */
const DEFAULT_VESPA_DOCUMENT_GET_DELETE_TIMEOUT_MS = 10_000;

export const VespaEnvSchema = z.object({
  VESPA_URL: z.string().url().default('http://localhost:8080'),
  VESPA_CONTENT_CLUSTER: z.string().min(1).default('wine_content'),
  VESPA_SEARCH_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_VESPA_SEARCH_REQUEST_TIMEOUT_MS),
  VESPA_DOCUMENT_MUTATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_VESPA_DOCUMENT_MUTATION_TIMEOUT_MS),
  VESPA_DOCUMENT_GET_DELETE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_VESPA_DOCUMENT_GET_DELETE_TIMEOUT_MS),
});
