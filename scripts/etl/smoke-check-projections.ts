#!/usr/bin/env tsx
/**
 * Spot-check script: verifies hit_summary and feature_summary fields are present in Vespa.
 * Run after full reindex to validate projection boundary deployment.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/smoke-check-projections.ts
 *   VESPA_URL=http://localhost:18080 npx tsx scripts/etl/smoke-check-projections.ts
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed or no documents found in index
 *
 * See: docs/migration/projection-reindex-strategy.md §3 Step 5
 */

import 'dotenv/config';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { VespaSearchIndex } from '../../src/infrastructure/vespa/vespa-search-index.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:18080';
const NAMESPACE = 'wine';
const DOC_TYPE = 'wine_entity';

// ---------------------------------------------------------------------------
// Check result helpers
// ---------------------------------------------------------------------------

let totalChecks = 0;
let failedChecks = 0;

function pass(summary: string, field: string, detail?: string): void {
  totalChecks++;
  const note = detail !== undefined ? `  (${detail})` : '';
  console.log(`[${summary}]  PASS  ${field}${note}`);
}

function fail(summary: string, field: string, reason: string): void {
  totalChecks++;
  failedChecks++;
  console.error(`[${summary}]  FAIL  ${field}  — ${reason}`);
}

// ---------------------------------------------------------------------------
// Discover a sample entity ID from the index
// ---------------------------------------------------------------------------

/**
 * Fetches the entity_id of the first available document from Vespa.
 * Uses a broad YQL query to find any indexed wine document.
 */
async function findSampleEntityId(client: VespaClient): Promise<CanonicalEntityId | null> {
  const response = await client.query(
    `select entity_id from ${DOC_TYPE} where true limit 1`,
  );
  const hit = response.root.children?.[0];
  if (hit === undefined) return null;
  const raw = hit.fields['entity_id'];
  if (typeof raw !== 'string') return null;
  return createCanonicalEntityId(raw);
}

// ---------------------------------------------------------------------------
// hit_summary checks
// ---------------------------------------------------------------------------

/**
 * Fetch one document using hit_summary and verify canonicalLabel + producer present.
 */
async function checkHitSummary(
  searchIndex: VespaSearchIndex,
  entityId: CanonicalEntityId,
): Promise<void> {
  const results = await searchIndex.fetchWithHitSummary([entityId]);
  const hit = results[0];

  if (hit === undefined) {
    fail('hit_summary', 'entity_id', 'document not returned by fetchWithHitSummary');
    fail('hit_summary', 'canonical_label', 'document not returned by fetchWithHitSummary');
    fail('hit_summary', 'producer', 'document not returned by fetchWithHitSummary');
    return;
  }

  // entity_id
  if (typeof hit.entityId === 'string' && hit.entityId.length > 0) {
    pass('hit_summary', 'entity_id', hit.entityId);
  } else {
    fail('hit_summary', 'entity_id', `got ${JSON.stringify(hit.entityId)}`);
  }

  // canonicalLabel — required field
  if (typeof hit.canonicalLabel === 'string' && hit.canonicalLabel.trim().length > 0) {
    pass('hit_summary', 'canonical_label', hit.canonicalLabel);
  } else {
    fail('hit_summary', 'canonical_label', `got ${JSON.stringify(hit.canonicalLabel)}`);
  }

  // producer — optional but should be present on most real wines
  if (hit.producer !== undefined && typeof hit.producer === 'string' && hit.producer.trim().length > 0) {
    pass('hit_summary', 'producer', hit.producer);
  } else {
    // producer is optional — log as a warning, not a hard failure
    pass('hit_summary', 'producer', 'absent (optional field — OK if wine has no producer)');
  }
}

// ---------------------------------------------------------------------------
// feature_summary checks
// ---------------------------------------------------------------------------

/**
 * Fetch one document using feature_summary and verify body + tannin are present
 * (or gracefully absent if the document has no tannin value).
 */
async function checkFeatureSummary(
  searchIndex: VespaSearchIndex,
  entityId: CanonicalEntityId,
): Promise<void> {
  const results = await searchIndex.fetchWithFeatureSummary([entityId]);
  const hit = results[0];

  if (hit === undefined) {
    fail('feature_summary', 'entity_id', 'document not returned by fetchWithFeatureSummary');
    fail('feature_summary', 'body', 'document not returned by fetchWithFeatureSummary');
    return;
  }

  // entity_id
  if (typeof hit.entityId === 'string' && hit.entityId.length > 0) {
    pass('feature_summary', 'entity_id', hit.entityId);
  } else {
    fail('feature_summary', 'entity_id', `got ${JSON.stringify(hit.entityId)}`);
  }

  // body — required numeric feature in [0, 1]
  if (typeof hit.body === 'number' && hit.body >= 0 && hit.body <= 1) {
    pass('feature_summary', 'body in [0,1]', String(hit.body));
  } else {
    fail('feature_summary', 'body', `expected number in [0,1], got ${JSON.stringify(hit.body)}`);
  }

  // tannin — optional; absent is OK if the wine has no tannin value
  if (hit.tannin !== undefined) {
    if (typeof hit.tannin === 'number' && hit.tannin >= 0 && hit.tannin <= 1) {
      pass('feature_summary', 'tannin in [0,1]', String(hit.tannin));
    } else {
      fail('feature_summary', 'tannin', `expected number in [0,1] or absent, got ${JSON.stringify(hit.tannin)}`);
    }
  } else {
    pass('feature_summary', 'tannin', 'absent (optional field — OK if wine has no tannin)');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Connecting to Vespa at ${VESPA_URL} …`);
  const client = new VespaClient(VESPA_URL, NAMESPACE, DOC_TYPE);
  const searchIndex = new VespaSearchIndex(client);

  // Discover a sample entity ID from the index
  console.log('Discovering sample document from index …');
  const entityId = await findSampleEntityId(client);

  if (entityId === null) {
    console.error(
      'ERROR: No documents found in the Vespa index.\n' +
      'Run the full reindex (index-to-vespa.ts) before running this check.',
    );
    process.exit(1);
  }

  console.log(`  Using entity_id: ${entityId}\n`);

  // Fetch one document using hit_summary → verify canonicalLabel, producer present
  await checkHitSummary(searchIndex, entityId);

  // Fetch one document using feature_summary → verify body, tannin present (or missing is OK if empty)
  await checkFeatureSummary(searchIndex, entityId);

  // Print PASS/FAIL per check
  console.log(`\n${totalChecks} checks, ${failedChecks} failed.`);

  if (failedChecks === 0) {
    console.log('All projection checks passed.');
  } else {
    console.error(`${failedChecks} projection check(s) FAILED. Do not cut over DNS until resolved.`);
    console.error('See: docs/migration/projection-reindex-strategy.md §5 (Rollback Plan)');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
