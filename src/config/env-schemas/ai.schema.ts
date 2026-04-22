import { z } from 'zod';

/**
 * LLM / chat model providers and the security-layer judge/interpreter flags
 * gated on those keys. Runtime chat and the default Layer 2 injection judge
 * are OpenAI-compatible.
 */

/** OpenAI-compatible client read timeout (chat/completions can be slow). */
const DEFAULT_OPENAI_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_LLM_QUERY_INTERPRETER_TIMEOUT_MS = 5_000;
const DEFAULT_OPENAI_INJECTION_HTTP_TIMEOUT_MS = 45_000;

export const AiEnvSchema = z.object({
  // OpenAI API (optional — hexagonal ChatLlmPort + optional OpenAiEmbeddingService)
  // z.preprocess: coerce empty string "" → undefined so `apiKey !== undefined` checks
  // in container-adapters.ts and readiness.ts correctly skip the OpenAI path when the
  // env var is set to an empty string. Without this, OPENAI_API_KEY="" passes as ""
  // and produces `Authorization: Bearer ` (empty token) → 401 from OpenAI, masking
  // the misconfiguration as a service failure instead of a config error.
  OPENAI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Optional comma/newline-separated OpenAI-compatible credential pool. */
  OPENAI_API_KEYS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Must include `/v1` for official API, e.g. `https://api.openai.com/v1` */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /** OpenAI model for Layer 2 prompt-injection classification when selected. */
  OPENAI_INJECTION_MODEL: z.string().min(1).optional(),
  OPENAI_INJECTION_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_INJECTION_HTTP_TIMEOUT_MS),
  /**
   * Wall-clock timeout for the Layer 2 injection judge orchestration.
   * When omitted, runtime wiring aligns this with the provider HTTP timeout
   * to avoid fail-closed drift between the outer gate and the inner adapter.
   */
  INJECTION_JUDGE_TIMEOUT_MS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  /**
   * Model used for index-time Doc2Query synthetic-query generation
   * (`scripts/etl/generate-doc-queries.ts`). Decoupled from
   * `OPENAI_CHAT_MODEL` so the ETL pass can run on a cheaper / different
   * model than the runtime chat path without affecting query interpreter,
   * agent, or any other in-request LLM call.
   */
  OPENAI_DOC2QUERY_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /**
   * Embedding model for dense retrieval via OpenAI-compatible API.
   * Defaults to text-embedding-3-small — the most cost-effective option.
   * When an OpenAI key or key pool is set, this model is used automatically.
   * Set to a different model (e.g. text-embedding-3-large) for higher quality.
   */
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  OPENAI_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_HTTP_TIMEOUT_MS),
  /** Enable LLM-backed query constraint extraction (requires OPENAI_API_KEY or OPENAI_API_KEYS). */
  LLM_QUERY_INTERPRETER: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Timeout for LLM query interpreter calls (ms). */
  LLM_QUERY_INTERPRETER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LLM_QUERY_INTERPRETER_TIMEOUT_MS),

  // Anthropic API (legacy explicit provider only; OpenAI is the default security judge).
  // z.preprocess: coerce "" → undefined (same rationale as OPENAI_API_KEY above).
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Model id for injection classifier (Messages API). Override for newer Sonnet/Haiku. */
  ANTHROPIC_INJECTION_MODEL: z.string().min(1).optional(),
  /** Provider for Layer 2 prompt-injection classification. */
  LLM_INJECTION_PROVIDER: z.enum(['anthropic', 'openai']).default('openai'),
  /**
   * Allow LLM injection judge failures to bypass Layer 2 blocking.
   *
   * Default: false (fail_closed). When the LLM judge is unavailable,
   * queries are BLOCKED as a precaution. Set to 'true' (fail_open) in
   * deployments where Layer 1 regex sanitizer alone provides sufficient
   * protection and judge unavailability should not DoS the search service.
   */
  INJECTION_JUDGE_FAIL_OPEN: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});
