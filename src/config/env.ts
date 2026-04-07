import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Schema for all environment variables required by the Wine Intelligence Engine.
 * Uses Zod for runtime validation and type inference.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /** Per-IP request cap (RFC-014 §13). Set high for local offline eval; use 0 to disable. */
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(100),

  /**
   * Trust `X-Forwarded-*` headers (client IP, proto) when behind a reverse proxy / load balancer.
   * Set true in production behind ALB/nginx; keep false for direct-to-process local runs.
   */
  HTTP_TRUST_PROXY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /** Max JSON body size in bytes (Fastify `bodyLimit`). Default 1 MiB. */
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(32 * 1024 * 1024).default(1_048_576),

  /**
   * When set (≥16 chars), clients may send `X-Debug-Key: <same value>` for per-request log level `debug`.
   */
  HTTP_DEBUG_SECRET: z.string().min(16).optional(),

  /** Register `@fastify/helmet` security headers (recommended on in production). */
  HTTP_SECURITY_HEADERS: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('true'),

  /** Comma-separated list of allowed CORS origins. Defaults to '*' in development. */
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  /** Run evaluation on startup (fire-and-forget). */
  EVAL_RUN_AT_STARTUP: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  // PostgreSQL
  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DATABASE: z.string().min(1).default('wine_engine'),
  PG_USER: z.string().min(1).default('wine'),
  PG_PASSWORD: z.string().default(''),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PG_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Vespa
  VESPA_URL: z.string().url().default('http://localhost:8080'),
  VESPA_CONTENT_CLUSTER: z.string().min(1).default('wine_content'),

  // Embedding Service
  EMBEDDING_SERVICE_URL: z.string().url().default('http://localhost:8081'),
  EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
  /** Expected embedding vector dimension. When set, vectors with mismatched dimensions are rejected. */
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().optional(),
  /** Per-request HTTP timeout for embedding API calls (AbortSignal). */
  EMBEDDING_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Reranker Service (optional external HTTP API)
  RERANKER_SERVICE_URL: z.string().url().optional(),
  /** Multiplies query-class rerank blend weights; lower = trust cross-encoder less (0–1). */
  RERANK_BLEND_SCALE: z.coerce.number().min(0).max(1).default(0.7),
  /** Per-request HTTP timeout for reranker API calls (AbortSignal). */
  RERANKER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Cohere reranker (preferred managed reranking)
  COHERE_API_KEY: z.string().optional(),
  COHERE_RERANK_MODEL: z.string().min(1).default('rerank-v4.0-pro'),
  COHERE_BASE_URL: z.string().url().default('https://api.cohere.ai/v2'),

  // Learned Matcher Service (optional — omit to disable RFC-006 §5.2 ML blend)
  LEARNED_MATCHER_SERVICE_URL: z.string().url().optional(),
  /** Per-request HTTP timeout for learned matcher API calls (AbortSignal). */
  LEARNED_MATCHER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // OpenAI API (optional — hexagonal ChatLlmPort + optional OpenAiEmbeddingService)
  OPENAI_API_KEY: z.string().optional(),
  /** Must include `/v1` for official API, e.g. `https://api.openai.com/v1` */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /**
   * When set together with OPENAI_API_KEY, dense retrieval uses OpenAI embeddings
   * instead of EMBEDDING_SERVICE_URL (HttpEmbeddingService).
   */
  OPENAI_EMBEDDING_MODEL: z.string().min(1).optional(),
  OPENAI_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Enable LLM-backed query constraint extraction (requires OPENAI_API_KEY). */
  LLM_QUERY_INTERPRETER: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Timeout for LLM query interpreter calls (ms). */
  LLM_QUERY_INTERPRETER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Anthropic API (for LLM-based security features like Epic 16.1 injection judge)
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model id for injection classifier (Messages API). Override for newer Sonnet/Haiku. */
  ANTHROPIC_INJECTION_MODEL: z.string().min(1).optional(),
  /** Allow LLM injection judge failures to bypass Layer 2 blocking. Defaults to safer fail-closed. */
  INJECTION_JUDGE_FAIL_OPEN: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Explicit production opt-in for heuristic-only drinking-window prediction. */
  ALLOW_HEURISTIC_DRINKING_WINDOW: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Optional directory containing `window_start.onnx` and `window_end.onnx`. */
  DRINKING_WINDOW_MODEL_DIR: z.string().min(1).optional(),

  // Watchlist webhook signing secret (Epic 17.1)
  WATCHLIST_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  WEBHOOK_SECRET: z.string().min(16).optional(),

  // Kill Switches
  KILL_SWITCH_ALIAS_OVERLAY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_LEARNING: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_DENSE_RETRIEVAL: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Kill switch for LLM-based injection judge (Layer 2). Use only in emergencies. */
  KILL_SWITCH_INJECTION_JUDGE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Kill switch for query caching (Wave 4, Phase 3). */
  KILL_SWITCH_QUERY_CACHE: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /** Confidence refusal threshold for hallucination prevention (Epic 17.3).
   * When set (in range [0, 1]), enables confidence-based refusal in AdmissionGate.
   * Default: unset (confidence check disabled, backward compatible).
   * Recommended: 0.45 (AURC-calibrated operating point). */
  CONFIDENCE_REFUSAL_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
});

type EnvVars = z.infer<typeof envSchema>;

function buildConfig(parsed: EnvVars) {
  const watchlistEnabled = parsed.WATCHLIST_ENABLED ?? parsed.WEBHOOK_SECRET !== undefined;

  if (watchlistEnabled && parsed.WEBHOOK_SECRET === undefined) {
    throw new Error('WATCHLIST_ENABLED requires WEBHOOK_SECRET to be set');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,

    /** HTTP rate limiting (Fastify @fastify/rate-limit). */
    httpRateLimit: {
      max: parsed.HTTP_RATE_LIMIT_MAX,
    },

    /** HTTP server tuning (Fastify instance options). */
    http: {
      trustProxy: parsed.HTTP_TRUST_PROXY,
      bodyLimitBytes: parsed.HTTP_BODY_LIMIT_BYTES,
      securityHeaders: parsed.HTTP_SECURITY_HEADERS,
      debugSecret: parsed.HTTP_DEBUG_SECRET,
    },

    /** CORS allowed origins. Empty string means allow all in dev, none in production. */
    corsAllowedOrigins: parsed.CORS_ALLOWED_ORIGINS,

    /** Optional startup evaluation. */
    eval: {
      runAtStartup: parsed.EVAL_RUN_AT_STARTUP,
    },

    /** PostgreSQL connection settings. */
    pg: {
      host: parsed.PG_HOST,
      port: parsed.PG_PORT,
      database: parsed.PG_DATABASE,
      user: parsed.PG_USER,
      password: parsed.PG_PASSWORD,
      poolMax: parsed.PG_POOL_MAX,
      idleTimeoutMillis: parsed.PG_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: parsed.PG_POOL_CONNECTION_TIMEOUT_MS,
    },

    /** Redis connection settings. */
    redis: {
      url: parsed.REDIS_URL,
    },

    /** Vespa search backend settings. */
    vespa: {
      url: parsed.VESPA_URL,
      contentCluster: parsed.VESPA_CONTENT_CLUSTER,
    },

    /** Embedding service settings. */
    embedding: {
      url: parsed.EMBEDDING_SERVICE_URL,
      model: parsed.EMBEDDING_MODEL,
      dimension: parsed.EMBEDDING_DIMENSION,
      httpTimeoutMs: parsed.EMBEDDING_HTTP_TIMEOUT_MS,
    },

    /** Reranker service settings. */
    reranker: {
      url: parsed.RERANKER_SERVICE_URL,
      blendScale: parsed.RERANK_BLEND_SCALE,
      httpTimeoutMs: parsed.RERANKER_HTTP_TIMEOUT_MS,
    },

    /** Cohere managed reranker settings (optional). */
    cohere: {
      apiKey: parsed.COHERE_API_KEY,
      rerankModel: parsed.COHERE_RERANK_MODEL,
      baseUrl: parsed.COHERE_BASE_URL,
    },

    /** Learned matcher service settings (optional). */
    learnedMatcher: {
      url: parsed.LEARNED_MATCHER_SERVICE_URL,
      httpTimeoutMs: parsed.LEARNED_MATCHER_HTTP_TIMEOUT_MS,
    },

    /** OpenAI API settings (optional chat + optional embeddings override). */
    openai: {
      apiKey: parsed.OPENAI_API_KEY,
      baseUrl: parsed.OPENAI_BASE_URL,
      chatModel: parsed.OPENAI_CHAT_MODEL,
      embeddingModel: parsed.OPENAI_EMBEDDING_MODEL,
      httpTimeoutMs: parsed.OPENAI_HTTP_TIMEOUT_MS,
      llmQueryInterpreter: parsed.LLM_QUERY_INTERPRETER,
      llmQueryInterpreterTimeoutMs: parsed.LLM_QUERY_INTERPRETER_TIMEOUT_MS,
    },

    /** Anthropic API settings (optional, for LLM-based security features). */
    anthropic: {
      apiKey: parsed.ANTHROPIC_API_KEY,
      injectionModel:
        parsed.ANTHROPIC_INJECTION_MODEL ?? 'claude-haiku-4-5-20251001',
    },

    /** Query-entry security behavior (Layer 1 + Layer 2 prompt-injection defense). */
    queryEntrySecurity: {
      judgeFailureMode: parsed.INJECTION_JUDGE_FAIL_OPEN ? 'fail_open' : 'fail_closed',
    },

    /** Watchlist webhook settings (Epic 17.1). */
    watchlist: {
      enabled: watchlistEnabled,
      webhookSecret: parsed.WEBHOOK_SECRET,
    },

    /** Confidence refusal settings (Epic 17.3: Hallucination Verify). */
    confidenceRefusal: {
      threshold: parsed.CONFIDENCE_REFUSAL_THRESHOLD,
    },

    /** Drinking-window runtime policy. */
    drinkingWindow: {
      allowHeuristicInProduction: parsed.ALLOW_HEURISTIC_DRINKING_WINDOW,
      modelDir: parsed.DRINKING_WINDOW_MODEL_DIR,
    },

    /** Kill switches for feature flags / circuit breakers. */
    killSwitch: {
      aliasOverlay: parsed.KILL_SWITCH_ALIAS_OVERLAY,
      learning: parsed.KILL_SWITCH_LEARNING,
      denseRetrieval: parsed.KILL_SWITCH_DENSE_RETRIEVAL,
      injectionJudge: parsed.KILL_SWITCH_INJECTION_JUDGE,
      queryCache: parsed.KILL_SWITCH_QUERY_CACHE,
    },
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return buildConfig(envSchema.parse(env));
}

export function loadConfig(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadDotenv?: boolean;
}): Config {
  if (options?.loadDotenv ?? true) {
    dotenv.config({ path: '.env.local', override: false });
    dotenv.config({ override: false });
  }

  return parseEnv(options?.env ?? process.env);
}

/**
 * Parsed and validated environment variables.
 * Throws a descriptive error at startup if any required variable is missing or malformed.
 */
export const config = loadConfig();
