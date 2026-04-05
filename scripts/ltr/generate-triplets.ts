#!/usr/bin/env tsx
/**
 * Generates training triplets from golden queries for embedding fine-tuning.
 *
 * Reads: data/golden-queries-bronze.jsonl (500 queries)
 * Outputs: data/triplets-train.jsonl (~2000 triplets)
 *
 * For each query with ground_truth labels:
 *   - Positive: top-1 relevant entity from ground_truth
 *   - Hard negative: entity NOT in ground_truth that ranks highest in embedding space
 *     (simulated by finding closest non-relevant entity based on attributes)
 *
 * Format: { "query": "...", "positive": "...", "hard_negative": "..." }
 *
 * Run: npx tsx scripts/ltr/generate-triplets.ts
 */

import 'dotenv/config';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GoldenQuery {
  qid: string;
  query: string;
  retrieval_labels: {
    relevant: Array<{
      entity_id: string;
      grade: number;
    }>;
  };
  decision_labels?: {
    expected_decision_status?: string;
    expected_entity_id?: string;
  };
}

interface Triplet {
  query: string;
  positive: string;
  hard_negative: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_FILE = 'data/golden-queries-bronze.jsonl';
const OUTPUT_FILE = 'data/triplets-train.jsonl';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two normalized vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/**
 * Deterministic embedding from sensory attributes (matches seed-wines-real.ts).
 * Used to compute "hard negatives" as entities with high embedding similarity
 * but NOT in ground truth.
 */
function makeEmbedding(
  body: number,
  sweetness: number,
  acidity: number,
  tannin: number,
): number[] {
  const features = [
    body, sweetness, acidity, tannin,
    1 - body, 1 - sweetness, 1 - acidity, 1 - tannin,
  ];
  const embedding = new Array<number>(128).fill(0);
  for (let i = 0; i < 128; i++) {
    const f = features[i % features.length]!;
    const k = Math.floor(i / features.length);
    embedding[i] = f * Math.cos(k * Math.PI / 8) + (1 - f) * Math.sin(k * Math.PI / 8);
  }
  const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
  return embedding.map((x) => x / norm);
}

/**
 * Loads all lines from an NDJSON file.
 */
async function loadNdjson<T>(filePath: string): Promise<T[]> {
  const items: T[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        items.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed lines
      }
    }
  }

  return items;
}

/**
 * Saves items as NDJSON (one JSON object per line).
 */
async function saveNdjson<T>(filePath: string, items: readonly T[]): Promise<void> {
  const lines = items.map((item) => JSON.stringify(item)).join('\n');
  await fs.writeFile(filePath, lines + '\n', 'utf-8');
}

/**
 * Generates a synthetic wine corpus for hard negative selection.
 * In production, would load all wines from Vespa/PostgreSQL.
 */
function generateSyntheticWineCorpus(): Record<string, Record<string, unknown>> {
  const corpus: Record<string, Record<string, unknown>> = {};

  // Common wine profiles for hard negative selection
  const wineProfiles = [
    { id: 'wine-red-full-dry', body: 0.85, sweetness: 0.05, acidity: 0.70, tannin: 0.80 },
    { id: 'wine-red-medium', body: 0.70, sweetness: 0.10, acidity: 0.65, tannin: 0.65 },
    { id: 'wine-red-light', body: 0.55, sweetness: 0.15, acidity: 0.75, tannin: 0.50 },
    { id: 'wine-white-dry', body: 0.40, sweetness: 0.05, acidity: 0.80, tannin: 0.10 },
    { id: 'wine-white-fruity', body: 0.45, sweetness: 0.35, acidity: 0.75, tannin: 0.10 },
    { id: 'wine-white-rich', body: 0.65, sweetness: 0.20, acidity: 0.65, tannin: 0.15 },
    { id: 'wine-pink-dry', body: 0.50, sweetness: 0.10, acidity: 0.70, tannin: 0.25 },
    { id: 'wine-sparkling-dry', body: 0.35, sweetness: 0.08, acidity: 0.85, tannin: 0.05 },
  ];

  for (const profile of wineProfiles) {
    corpus[profile.id] = {
      embedding: makeEmbedding(profile.body, profile.sweetness, profile.acidity, profile.tannin),
      ...profile,
    };
  }

  return corpus;
}

/**
 * Finds hard negative candidates: entities NOT in ground_truth
 * that have high embedding similarity to the positive.
 */
function findHardNegatives(
  positiveId: string,
  relevantIds: Set<string>,
  corpus: Record<string, Record<string, unknown>>,
): string[] {
  const positiveEmbed = (corpus[positiveId]?.embedding as number[]) ||
    makeEmbedding(0.75, 0.15, 0.70, 0.70); // default profile

  const candidates = Object.entries(corpus)
    .filter(([id]) => id !== positiveId && !relevantIds.has(id))
    .map(([id, doc]) => {
      const embedding = (doc.embedding as number[]) || [];
      const sim = cosineSimilarity(positiveEmbed, embedding);
      return { id, sim };
    })
    .sort((a, b) => b.sim - a.sim);

  return candidates.slice(0, 10).map((c) => c.id);
}

/**
 * Generates triplets from queries.
 *
 * Returns triplets where:
 * - query: the user's search text
 * - positive: a relevant entity from ground_truth
 * - hard_negative: a non-relevant entity with high embedding similarity
 */
async function generateTriplets(
  queries: readonly GoldenQuery[],
): Promise<readonly Triplet[]> {
  const triplets: Triplet[] = [];
  const corpus = generateSyntheticWineCorpus();

  console.log(`📊 Generating triplets from ${queries.length} queries...`);
  let queriesWithMultipleAnswers = 0;

  for (const q of queries) {
    const relevant = q.retrieval_labels.relevant;
    if (relevant.length === 0) {
      // Skip queries with no relevant entities
      continue;
    }

    // Take all relevant entities as positives (generate triplet for each)
    const relevantIds = new Set(relevant.map((r) => r.entity_id));

    for (const rel of relevant) {
      const positiveId = rel.entity_id;

      // Find hard negatives from corpus
      const hardNegs = findHardNegatives(positiveId, relevantIds, corpus);

      // Generate one triplet per hard negative candidate
      for (const hardNegId of hardNegs) {
        triplets.push({
          query: q.query,
          positive: positiveId,
          hard_negative: hardNegId,
        });
      }
    }

    if (relevant.length > 1) {
      queriesWithMultipleAnswers++;
    }
  }

  console.log(
    `✅ Generated ${triplets.length} triplets from ${queries.length} queries ` +
    `(${queriesWithMultipleAnswers} queries with multiple answers)`,
  );

  return triplets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    console.log(`📖 Loading queries from ${INPUT_FILE}...`);
    const queries = await loadNdjson<GoldenQuery>(INPUT_FILE);
    console.log(`✅ Loaded ${queries.length} queries`);

    const triplets = await generateTriplets(queries);

    console.log(`💾 Saving ${triplets.length} triplets to ${OUTPUT_FILE}...`);
    await saveNdjson(OUTPUT_FILE, triplets);
    console.log(`✅ Done! Triplets saved to ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
