#!/usr/bin/env tsx
/**
 * Re-indexes Vespa with new embedding vectors from fine-tuned/distilled model.
 *
 * Workflow:
 * 1. Load all wine documents from Vespa (via sparse query)
 * 2. For each document, generate embeddings with new embedding service
 * 3. Upsert documents with new embeddings back to Vespa
 * 4. Preserve all existing fields; only update embedding vectors
 *
 * Inputs:
 * - OPENAI_API_KEY env var (points to new embedding model)
 * - All documents currently in Vespa index
 *
 * Outputs:
 * - Updated Vespa index with new embedding vectors
 *
 * Usage:
 *   OPENAI_API_KEY=http://localhost:8000 npx tsx scripts/ltr/reindex-embeddings.ts
 *
 * Note: Instruction prefix "Represent this wine for retrieval: [doc text]"
 *       must be preserved for consistency with original BGE-M3 training.
 */

import 'dotenv/config';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { HttpEmbeddingService } from '../../src/infrastructure/vespa/embedding-service.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:18080';
const NAMESPACE = 'wine';
const SCHEMA = 'wine_entity';
const BATCH_SIZE = 50;

// Instruction prefix for embedding (must match original model training)
const INSTRUCTION_PREFIX = 'Represent this wine for retrieval: ';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a text representation of a document for embedding.
 * Combines multiple text fields to capture semantic content.
 */
function buildDocumentText(doc: RetrievalDocument): string {
  const parts: string[] = [];

  if (doc.semanticSummary) {
    parts.push(doc.semanticSummary);
  }

  if (doc.canonicalLabel) {
    parts.push(doc.canonicalLabel);
  }

  if (doc.searchTextEn) {
    parts.push(doc.searchTextEn);
  }

  // Flatten all text and limit to avoid token overflow
  const combined = parts.join(' ').trim();
  const tokens = combined.split(/\s+/);
  const limited = tokens.slice(0, 512).join(' '); // Limit to ~512 tokens

  return limited;
}

/**
 * Fetches all documents from Vespa index in batches.
 * Uses a YQL query to fetch all documents.
 */
async function fetchAllDocuments(
  client: VespaClient,
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const docs: Array<{ id: string; fields: Record<string, unknown> }> = [];

  // Query all documents using YQL
  // Fetch in chunks to avoid memory issues
  let offset = 0;
  const chunkSize = 100;

  for (;;) {
    console.log(`📍 Fetching documents [${offset}, ${offset + chunkSize})...`);

    const response = await client.query(
      `select * from ${SCHEMA} limit ${chunkSize} offset ${offset}`,
    );

    const hits = response.root.children ?? [];
    if (hits.length === 0) {
      break;
    }

    for (const hit of hits) {
      // Extract entity_id from Vespa document ID
      // Vespa ID format: id:namespace:docType:docid:entityId
      const docId = hit.id.split(':').pop() ?? hit.id;
      docs.push({
        id: docId,
        fields: hit.fields,
      });
    }

    offset += chunkSize;
  }

  console.log(`✅ Fetched ${docs.length} documents from Vespa`);
  return docs;
}

/**
 * Generates embeddings for a batch of documents.
 * Uses the instruction prefix for consistency with original training.
 */
async function generateEmbeddings(
  embeddingService: HttpEmbeddingService,
  documents: Array<{ id: string; fields: Record<string, unknown>; text: string }>,
): Promise<Map<string, readonly number[]>> {
  const result = new Map<string, readonly number[]>();

  if (documents.length === 0) {
    return result;
  }

  // Prepare texts with instruction prefix
  const texts = documents.map((doc) => INSTRUCTION_PREFIX + doc.text);

  try {
    const embeddings = await embeddingService.embedBatch(texts);

    for (let i = 0; i < documents.length; i++) {
      const docId = documents[i]!.id;
      const embedding = embeddings[i];
      if (embedding !== undefined) {
        result.set(docId, embedding);
      }
    }
  } catch (error) {
    console.error('❌ Error generating embeddings:', error);
    throw error;
  }

  return result;
}

/**
 * Upserts documents with new embeddings back to Vespa.
 */
async function upsertDocuments(
  client: VespaClient,
  documents: Array<{
    id: string;
    fields: Record<string, unknown>;
    embedding: readonly number[];
  }>,
): Promise<void> {
  const docsToUpsert = documents.map((doc) => ({
    id: doc.id,
    fields: {
      ...doc.fields,
      embedding: { values: [...doc.embedding] },
    },
  }));

  const result = await client.bulkFeed(docsToUpsert);

  console.log(
    `✅ Upserted ${result.successCount} documents (${result.failureCount} failures)`,
  );

  if (result.errors.length > 0) {
    console.warn('⚠️  Some documents failed to upsert:');
    for (const error of result.errors.slice(0, 5)) {
      console.warn(`   ${error}`);
    }
    if (result.errors.length > 5) {
      console.warn(`   ... and ${result.errors.length - 5} more errors`);
    }
  }
}

/**
 * Main re-indexing workflow.
 */
async function reindexEmbeddings(): Promise<void> {
  console.log('🔄 Starting embedding re-indexing...\n');

  // Initialize clients
  const vespaClient = new VespaClient(VESPA_URL, NAMESPACE, SCHEMA);
  const embeddingService = new HttpEmbeddingService();

  try {
    // Step 1: Fetch all documents from Vespa
    console.log('📖 Fetching all documents from Vespa...');
    const allDocs = await fetchAllDocuments(vespaClient);

    if (allDocs.length === 0) {
      console.warn('⚠️  No documents found in index. Aborting.');
      return;
    }

    // Step 2: Process documents in batches
    console.log(`\n🔄 Processing ${allDocs.length} documents in batches...\n`);

    let processedCount = 0;

    for (let batchStart = 0; batchStart < allDocs.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, allDocs.length);
      const batch = allDocs.slice(batchStart, batchEnd);

      console.log(
        `📦 Batch [${batchStart}, ${batchEnd}) (${batch.length} documents)...`,
      );

      // Prepare batch documents with text representation
      const docsWithText = batch.map((doc) => {
        // Reconstruct RetrievalDocument from Vespa fields for text building
        const doc_text = buildDocumentText({
          entityId: doc.fields.entity_id as unknown as Record<string, unknown>,
          entityType: doc.fields.entity_type as string ?? 'wine',
          canonicalLabel: doc.fields.canonical_label as string ?? '',
          semanticSummary: doc.fields.semantic_summary as string ?? '',
          searchTextEn: doc.fields.search_text_en as string ?? '',
          aliasesIdentitySafe: [],
          aliasesNoisyRecall: [],
          producer: doc.fields.producer as string ?? '',
          region: doc.fields.region as string ?? '',
          grapes: [],
          searchTextKo: '',
          body: 0,
          sweetness: 0,
          style: '',
          priceBand: '',
          pairing: [],
          occasion: [],
          availability: false,
          popularityScore: 0,
        });

        return {
          id: doc.id,
          fields: doc.fields,
          text: doc_text,
        };
      });

      // Generate embeddings for batch
      const embeddings = await generateEmbeddings(embeddingService, docsWithText);

      // Prepare documents for upsert
      const docsToUpsert = docsWithText
        .map((doc) => ({
          id: doc.id,
          fields: doc.fields,
          embedding: embeddings.get(doc.id),
        }))
        .filter((doc) => doc.embedding !== undefined) as Array<{
        id: string;
        fields: Record<string, unknown>;
        embedding: readonly number[];
      }>;

      // Upsert to Vespa
      await upsertDocuments(vespaClient, docsToUpsert);

      processedCount += docsToUpsert.length;
      console.log(
        `   Progress: ${processedCount}/${allDocs.length} documents ` +
        `(${Math.round((processedCount / allDocs.length) * 100)}%)\n`,
      );
    }

    console.log(`\n✅ Re-indexing complete! Updated ${processedCount} documents.`);

  } catch (error) {
    console.error('❌ Re-indexing failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env['OPENAI_API_KEY']) {
  console.error(
    '❌ OPENAI_API_KEY environment variable not set.\n' +
    'Usage: OPENAI_API_KEY=http://localhost:8000 npx tsx scripts/ltr/reindex-embeddings.ts',
  );
  process.exit(1);
}

reindexEmbeddings().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
