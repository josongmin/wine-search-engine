#!/usr/bin/env tsx
/**
 * Re-indexes Vespa with 1024-dim embedding vectors via OpenAI API.
 *
 * Uses text-embedding-3-small with dimensions=1024 to match the Vespa
 * schema tensor<float>(x[1024]).
 *
 * Workflow:
 * 1. Fetch all wine documents from Vespa
 * 2. Build text representation for each document
 * 3. Generate 1024-dim embeddings via OpenAI API (batched)
 * 4. Partial-update only the embedding field back to Vespa
 *
 * Usage:
 *   npx tsx scripts/ltr/reindex-embeddings-openai.ts
 *   npx tsx scripts/ltr/reindex-embeddings-openai.ts --dry-run
 *   npx tsx scripts/ltr/reindex-embeddings-openai.ts --limit 100
 *
 * Requires OPENAI_API_KEY in .env or environment.
 */

import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:8080';
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
const OPENAI_BASE_URL = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
const EMBEDDING_MODEL = process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
const EMBEDDING_DIM = 1024;
const NAMESPACE = 'wine';
const SCHEMA = 'wine_entity';

/** OpenAI batch limit (text-embedding-3-small supports up to 2048 inputs). */
const OPENAI_BATCH_SIZE = 100;
/** Vespa feed batch size. */
const VESPA_BATCH_SIZE = 50;
/** Delay between OpenAI batches to respect rate limits (ms). */
const RATE_LIMIT_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = argv.indexOf('--limit');
  return idx >= 0 && idx + 1 < argv.length ? Number.parseInt(argv[idx + 1]!, 10) : undefined;
})();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface VespaHit {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface OpenAiEmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: readonly number[] }[];
  readonly usage: { readonly prompt_tokens: number; readonly total_tokens: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vespa helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllDocuments(): Promise<VespaHit[]> {
  const docs: VespaHit[] = [];
  // Use Vespa visit API (document/v1) which handles pagination correctly
  // without the maxOffset limitation of the search API.
  let continuation: string | undefined;

  for (;;) {
    let url = `${VESPA_URL}/document/v1/${NAMESPACE}/${SCHEMA}/docid/?wantedDocumentCount=500&cluster=${NAMESPACE}`;
    if (continuation) {
      url += `&continuation=${encodeURIComponent(continuation)}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Vespa visit failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      documents: { id: string; fields: Record<string, unknown> }[];
      continuation?: string;
    };
    const hits = body.documents ?? [];
    if (hits.length === 0) break;
    for (const doc of hits) {
      docs.push({ id: doc.id, fields: doc.fields });
    }
    if (LIMIT !== undefined && docs.length >= LIMIT) {
      return docs.slice(0, LIMIT);
    }
    process.stderr.write(`  fetched ${docs.length} docs...\r`);
    continuation = body.continuation;
    if (!continuation) break;
  }
  return docs;
}

async function partialUpdateEmbedding(
  docId: string,
  embedding: readonly number[],
): Promise<boolean> {
  const url = `${VESPA_URL}/document/v1/${NAMESPACE}/${SCHEMA}/docid/${docId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        embedding: { assign: { values: embedding } },
      },
    }),
  });
  return res.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI embedding
// ─────────────────────────────────────────────────────────────────────────────

async function embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  const url = `${OPENAI_BASE_URL.replace(/\/+$/, '')}/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed [${res.status}]: ${errText.slice(0, 300)}`);
  }

  const body = (await res.json()) as OpenAiEmbeddingResponse;

  // Sort by index to ensure alignment with input order
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);

  // Validate dimensions
  for (const vec of vectors) {
    if (vec.length !== EMBEDDING_DIM) {
      throw new Error(`Dimension mismatch: expected ${EMBEDDING_DIM}, got ${vec.length}`);
    }
  }

  return vectors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text builder
// ─────────────────────────────────────────────────────────────────────────────

function buildDocText(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (key: string) => {
    const val = fields[key];
    if (typeof val === 'string' && val.length > 0) parts.push(val);
  };
  add('semantic_summary');
  add('canonical_label');
  add('producer');
  add('region');
  add('search_text_en');
  add('search_text_ko');
  // Limit to ~400 tokens to stay within embedding model context
  return parts.join(' ').split(/\s+/).slice(0, 400).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set. Check .env or environment.');
    process.exit(1);
  }

  console.log(`\n=== Vespa Embedding Re-index (OpenAI ${EMBEDDING_MODEL}, ${EMBEDDING_DIM}d) ===`);
  console.log(`  Vespa:  ${VESPA_URL}`);
  console.log(`  Model:  ${EMBEDDING_MODEL}`);
  console.log(`  Dim:    ${EMBEDDING_DIM}`);
  if (DRY_RUN) console.log('  Mode:   DRY RUN (no writes)');
  if (LIMIT) console.log(`  Limit:  ${LIMIT} docs`);
  console.log();

  // 1. Fetch all docs
  console.log('1/3  Fetching documents from Vespa...');
  const docs = await fetchAllDocuments();
  console.log(`     ${docs.length} documents fetched.\n`);

  // 2. Generate embeddings in batches
  console.log('2/3  Generating embeddings via OpenAI API...');
  const embeddings = new Map<string, readonly number[]>();

  for (let i = 0; i < docs.length; i += OPENAI_BATCH_SIZE) {
    const batch = docs.slice(i, i + OPENAI_BATCH_SIZE);
    const texts = batch.map((d) => buildDocText(d.fields));
    const docIds = batch.map((d) => {
      const parts = d.id.split(':');
      return parts[parts.length - 1]!;
    });

    try {
      const vectors = await embedBatch(texts);
      for (let j = 0; j < docIds.length; j++) {
        embeddings.set(docIds[j]!, vectors[j]!);
      }
    } catch (err) {
      console.error(`     Batch [${i}, ${i + batch.length}) failed:`, err instanceof Error ? err.message : err);
      // Continue with remaining batches
    }

    process.stderr.write(`     ${Math.min(i + OPENAI_BATCH_SIZE, docs.length)}/${docs.length} embedded\r`);

    // Rate limit
    if (i + OPENAI_BATCH_SIZE < docs.length) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
  }
  console.log(`     ${embeddings.size} embeddings generated.\n`);

  if (DRY_RUN) {
    console.log('DRY RUN complete. No Vespa writes.');
    return;
  }

  // 3. Partial-update Vespa
  console.log('3/3  Updating Vespa embeddings...');
  let success = 0;
  let fail = 0;
  const entries = [...embeddings.entries()];

  for (let i = 0; i < entries.length; i += VESPA_BATCH_SIZE) {
    const batch = entries.slice(i, i + VESPA_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(([id, vec]) => partialUpdateEmbedding(id, vec).then((ok) => ({ id, ok }))),
    );
    for (const r of results) {
      if (r.ok) success++;
      else {
        fail++;
        if (fail <= 5) console.warn(`     FAIL: ${r.id}`);
      }
    }
    process.stderr.write(`     ${success + fail}/${entries.length} updated\r`);
  }

  console.log(`\n\n=== Done ===`);
  console.log(`  Success: ${success}`);
  console.log(`  Failed:  ${fail}`);
  console.log(`  Total:   ${success + fail}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
