import { z } from 'zod';

/**
 * LLM / chat model providers (OpenAI, Anthropic) and the security-layer
 * judge/interpreter flags gated on those keys.
 */

/** OpenAI-compatible client read timeout (chat/completions can be slow). */
const DEFAULT_OPENAI_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_LLM_QUERY_INTERPRETER_TIMEOUT_MS = 5_000;

export const AiEnvSchema = z.object({
  // OpenAI API (optional — hexagonal ChatLlmPort + optional OpenAiEmbeddingService)
  OPENAI_API_KEY: z.string().optional(),
  /** Must include `/v1` for official API, e.g. `https://api.openai.com/v1` */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().min(1).default('gpt-5.4-mini'),
  /**
   * Embedding model for dense retrieval via OpenAI-compatible API.
   * Defaults to text-embedding-3-small — the most cost-effective option.
   * When OPENAI_API_KEY is set, this model is used automatically.
   * Set to a different model (e.g. text-embedding-3-large) for higher quality.
   */
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  OPENAI_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_HTTP_TIMEOUT_MS),
  /** Enable LLM-backed query constraint extraction (requires OPENAI_API_KEY). */
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

  // Anthropic API (for LLM-based security features like Epic 16.1 injection judge)
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model id for injection classifier (Messages API). Override for newer Sonnet/Haiku. */
  ANTHROPIC_INJECTION_MODEL: z.string().min(1).optional(),
  /** Allow LLM injection judge failures to bypass Layer 2 blocking. Defaults to safer fail-closed. */
  INJECTION_JUDGE_FAIL_OPEN: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});
