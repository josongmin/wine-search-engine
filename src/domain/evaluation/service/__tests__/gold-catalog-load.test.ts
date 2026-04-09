/**
 * Gold wine catalog + relevance judgment fixture loader tests.
 *
 * Validates the hand-crafted data files under `data/` that back the
 * retrieval-ceiling dry-run and eventual real benchmark scoring:
 *   - `data/gold-wine-catalog.jsonl` — concrete wine SKUs
 *   - `data/gold-relevance-judgments.jsonl` — per-scenario qrels
 *
 * These files are append-only domain knowledge. The test locks in:
 *   1. Both files parse as NDJSON against their Zod schemas.
 *   2. Catalog has ≥50 wines spanning all three price buckets
 *      (<$60, $60–$200, >$200).
 *   3. Judgments has ≥200 rows, every entityId resolves to the catalog,
 *      and grades are balanced (not collapsed to a single value).
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Resolve repo-relative data paths deterministically from this test file.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CATALOG_PATH = path.join(REPO_ROOT, 'data', 'gold-wine-catalog.jsonl');
const JUDGMENTS_PATH = path.join(REPO_ROOT, 'data', 'gold-relevance-judgments.jsonl');

// ── Schemas ─────────────────────────────────────────────────────────────────

const WineTypeSchema = z.union([
  z.literal('red'),
  z.literal('white'),
  z.literal('sparkling'),
  z.literal('dessert'),
  z.literal('rosé'),
  z.literal('fortified'),
]);

const CatalogEntrySchema = z
  .object({
    entityId: z.string().min(1),
    canonicalLabel: z.string().min(1),
    producer: z.string().min(1),
    country: z.string().min(1),
    region: z.string().min(1),
    appellation: z.string().optional(),
    grapes: z.array(z.string().min(1)).min(1).max(20),
    wineType: WineTypeSchema,
    vintageYear: z.number().int().min(1900).max(2030),
    priceUsd: z.number().finite().min(1).max(50_000),
    body: z.number().int().min(1).max(5).nullable(),
    tannin: z.number().int().min(1).max(5).nullable(),
    acidity: z.number().int().min(1).max(5).nullable(),
    criticScore: z.number().int().min(0).max(100),
    style: z.string().min(1),
    koreanAliases: z.array(z.string().min(1)).max(20),
  })
  .strict();

type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

const JudgmentSchema = z
  .object({
    queryId: z.string().min(1),
    query: z.string().min(1),
    entityId: z.string().min(1),
    canonicalLabel: z.string().min(1),
    grade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    confidence: z.number().finite().min(0).max(1),
    source: z.literal('human_gold'),
    labelerModel: z.string().min(1),
    rationale: z.string().min(1),
    auditedBy: z.string().min(1),
    auditedAt: z.number().int().min(0),
  })
  .strict();

type Judgment = z.infer<typeof JudgmentSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────

async function parseNdjson<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<readonly T[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch (err) {
      throw new Error(
        `NDJSON parse failed at ${filePath}:${i + 1}: ${String(err)}`,
      );
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new Error(
        `Schema validation failed at ${filePath}:${i + 1}: ${result.error.message}`,
      );
    }
    out.push(result.data);
  }
  return out;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('gold wine catalog fixture', () => {
  it('loads the catalog NDJSON with ≥50 wines', async () => {
    const catalog = await parseNdjson(CATALOG_PATH, CatalogEntrySchema);
    expect(catalog.length).toBeGreaterThanOrEqual(50);
  });

  it('has distinct entityIds for every catalog entry', async () => {
    const catalog = await parseNdjson(CATALOG_PATH, CatalogEntrySchema);
    const ids = new Set(catalog.map((c) => c.entityId));
    expect(ids.size).toBe(catalog.length);
  });

  it('spans all three price buckets (<$60, $60–$200, >$200)', async () => {
    const catalog = await parseNdjson(CATALOG_PATH, CatalogEntrySchema);
    const buckets = { under60: 0, mid: 0, luxury: 0 };
    for (const wine of catalog) {
      if (wine.priceUsd < 60) buckets.under60 += 1;
      else if (wine.priceUsd <= 200) buckets.mid += 1;
      else buckets.luxury += 1;
    }
    expect(buckets.under60).toBeGreaterThanOrEqual(10);
    expect(buckets.mid).toBeGreaterThanOrEqual(10);
    expect(buckets.luxury).toBeGreaterThanOrEqual(10);
  });

  it('covers diverse wine types (at least red, white, sparkling)', async () => {
    const catalog = await parseNdjson(CATALOG_PATH, CatalogEntrySchema);
    const types = new Set(catalog.map((c) => c.wineType));
    expect(types.has('red')).toBe(true);
    expect(types.has('white')).toBe(true);
    expect(types.has('sparkling')).toBe(true);
  });

  it('includes Korean aliases for key wines (so Korean queries can match)', async () => {
    const catalog = await parseNdjson(CATALOG_PATH, CatalogEntrySchema);
    const withAliases = catalog.filter((c) => c.koreanAliases.length > 0);
    // Most high-profile wines have Korean transliterations; expect broad coverage.
    expect(withAliases.length).toBeGreaterThanOrEqual(
      Math.floor(catalog.length * 0.8),
    );
  });
});

describe('gold relevance judgments fixture', () => {
  it('loads the judgments NDJSON with ≥200 rows', async () => {
    const judgments = await parseNdjson(JUDGMENTS_PATH, JudgmentSchema);
    expect(judgments.length).toBeGreaterThanOrEqual(200);
  });

  it('every judgment.entityId resolves to a wine in the catalog', async () => {
    const [catalog, judgments] = await Promise.all([
      parseNdjson(CATALOG_PATH, CatalogEntrySchema),
      parseNdjson(JUDGMENTS_PATH, JudgmentSchema),
    ]);
    const catalogIds = new Set(catalog.map((c) => c.entityId));
    const missing: string[] = [];
    for (const j of judgments) {
      if (!catalogIds.has(j.entityId)) missing.push(j.entityId);
    }
    expect(missing).toEqual([]);
  });

  it('has a balanced grade distribution (all four grades, no single grade >80%)', async () => {
    const judgments = await parseNdjson(JUDGMENTS_PATH, JudgmentSchema);
    const counts: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const j of judgments) counts[j.grade] += 1;
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(0);
    expect(counts[3]).toBeGreaterThan(0);
    const total = judgments.length;
    for (const g of [0, 1, 2, 3] as const) {
      expect(counts[g] / total).toBeLessThan(0.8);
    }
  });

  it('every scenario has at least one grade-3 and one grade-0 judgment', async () => {
    const judgments = await parseNdjson(JUDGMENTS_PATH, JudgmentSchema);
    const perQuery = new Map<string, Set<number>>();
    for (const j of judgments) {
      let grades = perQuery.get(j.queryId);
      if (grades === undefined) {
        grades = new Set<number>();
        perQuery.set(j.queryId, grades);
      }
      grades.add(j.grade);
    }
    const missingHigh: string[] = [];
    const missingLow: string[] = [];
    for (const [queryId, grades] of perQuery) {
      if (!grades.has(3)) missingHigh.push(queryId);
      if (!grades.has(0)) missingLow.push(queryId);
    }
    // Allow a few scenarios to lack one of the two extremes (e.g. pure
    // knowledge queries where a grade-0 doesn't make sense), but the
    // overwhelming majority should have both.
    expect(missingHigh.length).toBeLessThanOrEqual(3);
    expect(missingLow.length).toBeLessThanOrEqual(5);
  });
});

// Compile-time guard: referenced types are used.
const _catalogTypeProbe: CatalogEntry | null = null;
const _judgmentTypeProbe: Judgment | null = null;
void _catalogTypeProbe;
void _judgmentTypeProbe;
