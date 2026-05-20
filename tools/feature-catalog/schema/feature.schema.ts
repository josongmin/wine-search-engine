/**
 * Feature Catalog — Zod schema (single source of truth).
 *
 * Each YAML under `tools/feature-catalog/features/<category>/*.yaml`
 * is parsed and validated against this schema before rendering.
 */

import { z } from 'zod';

/**
 * Maturity scale (1-5). Aligned with CLAUDE.md "SOTA++" baseline policy.
 *
 *   1 — Concept/Stub:  RFC or stub only, not wired into production.
 *   2 — Prototype:     One path implemented, happy path only, sparse tests.
 *   3 — Functional:    Wired into production, some regression tests.
 *   4 — Production:    Regression suite + observability + edge cases covered.
 *   5 — SOTA++:        Domain best-in-class, eval-proven, regression gates running.
 */
export const MaturitySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type Maturity = z.infer<typeof MaturitySchema>;

export const StatusSchema = z.enum([
  'active',
  'deprecated',
  'experimental',
  'planned',
]);
export type Status = z.infer<typeof StatusSchema>;

export const CategorySchema = z.enum([
  'retrieval',
  'agent',
  'nlu',
  'korean-i18n',
  'tools',
  'eval',
  'etl',
  'observability',
  'security',
  'infra',
]);
export type Category = z.infer<typeof CategorySchema>;

/** `category.kebab-name` — at least one dot, lowercase only. */
const FeatureIdRegex = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]+)+$/u;
/** YYYY-MM */
const YearMonthRegex = /^\d{4}-(0[1-9]|1[0-2])$/u;
/** YYYY-MM-DD */
const IsoDateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

const TestsSchema = z
  .object({
    unit: z.array(z.string().min(1)).max(50).default([]),
    integration: z.array(z.string().min(1)).max(50).default([]),
    e2e: z.array(z.string().min(1)).max(50).default([]),
    bench: z.array(z.string().min(1)).max(50).default([]),
    regression: z.array(z.string().min(1)).max(50).default([]),
  })
  .strict();

export const FeatureSchema = z
  .object({
    /** Stable, kebab-case dotted id (`category.subname`). Used in cross-refs. */
    id: z.string().regex(FeatureIdRegex, {
      message: 'must be lowercase dotted: category.kebab-name',
    }),
    name: z.string().min(1).max(100),
    category: CategorySchema,
    summary: z.string().min(10).max(500),

    maturity: MaturitySchema,
    /** Free-form justification for the maturity score. Required so reviewers can audit drift. */
    maturity_rationale: z.string().min(10).max(2000),

    status: StatusSchema,
    /** Approximate inception date (YYYY-MM). Optional. */
    since: z
      .string()
      .regex(YearMonthRegex, { message: 'must be YYYY-MM' })
      .optional(),
    /** Last manual review/refresh date (YYYY-MM-DD). Required so we can detect stale entries. */
    last_reviewed: z
      .string()
      .regex(IsoDateRegex, { message: 'must be YYYY-MM-DD' }),

    owner: z.string().min(1).max(60).optional(),

    /** Externally visible touchpoints (HTTP routes, CLI commands, tool names, etc.). */
    surfaces: z.array(z.string().min(1)).max(20).default([]),
    /** Implementation files, relative to repo root. Linted for existence. */
    key_files: z.array(z.string().min(1)).max(50).default([]),

    /** Tests covering this feature, by lane. Linted for existence. */
    tests: TestsSchema.optional(),

    /** Other feature ids this depends on. Linted for existence + self-reference. */
    depends_on: z
      .array(z.string().regex(FeatureIdRegex))
      .max(20)
      .default([]),
    /** Related RFC/doc files, relative to repo root. Linted for existence. */
    related_rfcs: z.array(z.string().min(1)).max(20).default([]),

    /** Free-form numeric/string KPIs (p50_ms, recall_at_10, etc.). Optional. */
    metrics: z
      .record(z.union([z.number().finite(), z.string()]))
      .optional(),

    known_limitations: z.array(z.string().min(1)).max(20).default([]),
    next_steps: z.array(z.string().min(1)).max(20).default([]),

    tags: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

export type Feature = z.infer<typeof FeatureSchema>;
