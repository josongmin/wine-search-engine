import { z } from 'zod';
import 'dotenv/config';

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

  // PostgreSQL
  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DATABASE: z.string().min(1).default('wine_engine'),
  PG_USER: z.string().min(1).default('wine'),
  PG_PASSWORD: z.string().min(1),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Vespa
  VESPA_URL: z.string().url().default('http://localhost:8080'),
  VESPA_CONTENT_CLUSTER: z.string().min(1).default('wine_content'),

  // Embedding Service
  EMBEDDING_SERVICE_URL: z.string().url().default('http://localhost:8081'),
  EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),

  // Reranker Service
  RERANKER_SERVICE_URL: z.string().url().default('http://localhost:8082'),
  /** Multiplies query-class rerank blend weights; lower = trust cross-encoder less (0–1). */
  RERANK_BLEND_SCALE: z.coerce.number().min(0).max(1).default(0.7),

  // Learned Matcher Service (optional — omit to disable RFC-006 §5.2 ML blend)
  LEARNED_MATCHER_SERVICE_URL: z.string().url().optional(),

  // Anthropic API (for LLM-based security features like Epic 16.1 injection judge)
  ANTHROPIC_API_KEY: z.string().optional(),

  // Watchlist webhook signing secret (Epic 17.1)
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

/**
 * Parsed and validated environment variables.
 * Throws a descriptive error at startup if any required variable is missing or malformed.
 */
const parsed: EnvVars = envSchema.parse(process.env);

/**
 * Application configuration object with typed, nested sections.
 */
export const config = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  logLevel: parsed.LOG_LEVEL,

  /** HTTP rate limiting (Fastify @fastify/rate-limit). */
  httpRateLimit: {
    max: parsed.HTTP_RATE_LIMIT_MAX,
  },

  /** PostgreSQL connection settings. */
  pg: {
    host: parsed.PG_HOST,
    port: parsed.PG_PORT,
    database: parsed.PG_DATABASE,
    user: parsed.PG_USER,
    password: parsed.PG_PASSWORD,
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
  },

  /** Reranker service settings. */
  reranker: {
    url: parsed.RERANKER_SERVICE_URL,
    blendScale: parsed.RERANK_BLEND_SCALE,
  },

  /** Learned matcher service settings (optional). */
  learnedMatcher: {
    url: parsed.LEARNED_MATCHER_SERVICE_URL,
  },

  /** Anthropic API settings (optional, for LLM-based security features). */
  anthropic: {
    apiKey: parsed.ANTHROPIC_API_KEY,
  },

  /** Watchlist webhook settings (Epic 17.1). */
  watchlist: {
    webhookSecret: parsed.WEBHOOK_SECRET,
  },

  /** Confidence refusal settings (Epic 17.3: Hallucination Verify). */
  confidenceRefusal: {
    threshold: parsed.CONFIDENCE_REFUSAL_THRESHOLD,
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

export type Config = typeof config;
