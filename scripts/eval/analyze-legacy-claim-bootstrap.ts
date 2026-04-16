#!/usr/bin/env tsx

/**
 * Analysis-only harness for the removed ADR-016 bootstrap corpus.
 *
 * This does NOT restore grounded-claim runtime. It replays the historical
 * 30-claim JSONL from git history against the current deterministic
 * `extractClaims()` path so we can see where today's legacy extractor still
 * misses the old bootstrap surfaces.
 *
 * Usage:
 *   npx tsx scripts/eval/analyze-legacy-claim-bootstrap.ts
 *   npx tsx scripts/eval/analyze-legacy-claim-bootstrap.ts --commit 221e098
 *   npx tsx scripts/eval/analyze-legacy-claim-bootstrap.ts --out /tmp/claim-bootstrap-report.json
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractClaims } from '../../src/domain/evaluation/service/claim-extractor.js';
import type { ClaimCategory, ExtractedClaim } from '../../src/domain/evaluation/model/claim.js';

type BootstrapClaimType =
  | 'entity_reference'
  | 'vintage_assertion'
  | 'price_assertion'
  | 'style_assertion'
  | 'attribute_assertion'
  | 'pairing_assertion'
  | 'recommendation'
  | 'comparative_assertion'
  | 'drinking_window_assertion';

export interface BootstrapClaimRow {
  readonly claimId: string;
  readonly claim: {
    readonly id: string;
    readonly type: BootstrapClaimType;
    readonly category: string;
    readonly text: string;
    readonly entityId?: string;
  };
  readonly expectedVerdict: string;
  readonly expectedConfidenceMin: number;
  readonly shadowAnswerText: string;
  readonly annotatorNote?: string;
}

interface LegacySurfaceExpectation {
  readonly expectedCategories: readonly ClaimCategory[];
  readonly expectedFields?: readonly string[];
}

export interface RowAnalysis {
  readonly claimId: string;
  readonly bootstrapType: BootstrapClaimType;
  readonly bootstrapCategory: string;
  readonly claimText: string;
  readonly shadowAnswerText: string;
  readonly expectedVerdict: string;
  readonly matched: boolean;
  readonly matchedByCategory: boolean;
  readonly matchedByField: boolean;
  readonly extractedClaims: readonly {
    readonly category: ClaimCategory;
    readonly field: string;
    readonly value: string;
    readonly normalizedValue: string;
  }[];
}

export interface AggregateBucket {
  readonly total: number;
  readonly matched: number;
  readonly unmatched: number;
}

export interface AnalysisReport {
  readonly corpusRef: string;
  readonly totalRows: number;
  readonly matchedRows: number;
  readonly unmatchedRows: number;
  readonly coverage: number;
  readonly byBootstrapType: Record<BootstrapClaimType, AggregateBucket>;
  readonly unmatchedRowsDetail: readonly RowAnalysis[];
  readonly notes: readonly string[];
}

const DEFAULT_COMMIT = '221e098';
const GOLD_CLAIMS_PATH = 'test/benchmark/agent/gold-claims/gold-claims.jsonl';

const LEGACY_SURFACE_EXPECTATIONS: Readonly<Record<BootstrapClaimType, LegacySurfaceExpectation>> = {
  entity_reference: {
    expectedCategories: ['identity_claim'],
    expectedFields: ['canonical_label', 'producer'],
  },
  vintage_assertion: {
    expectedCategories: ['core_structured_claim'],
    expectedFields: ['vintage_year'],
  },
  price_assertion: {
    expectedCategories: ['core_structured_claim'],
    expectedFields: ['price_usd'],
  },
  style_assertion: {
    expectedCategories: ['derived_structured_claim', 'semantic_claim'],
    expectedFields: ['style', 'style_description'],
  },
  attribute_assertion: {
    expectedCategories: ['derived_structured_claim', 'semantic_claim'],
    expectedFields: ['body', 'tannin', 'acidity', 'sweetness', 'finish_length', 'style'],
  },
  pairing_assertion: {
    expectedCategories: ['semantic_claim'],
    expectedFields: ['pairing_rationale'],
  },
  recommendation: {
    expectedCategories: ['semantic_claim'],
    expectedFields: ['general_opinion', 'occasion'],
  },
  comparative_assertion: {
    expectedCategories: ['comparative_claim'],
  },
  drinking_window_assertion: {
    expectedCategories: ['core_structured_claim', 'semantic_claim'],
    expectedFields: ['drinking_window_start', 'drinking_window_end', 'aging_potential'],
  },
};

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

export function loadHistoricalCorpus(commit: string): readonly BootstrapClaimRow[] {
  const ref = `${commit}:${GOLD_CLAIMS_PATH}`;
  const raw = execFileSync('git', ['show', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BootstrapClaimRow);
}

function matchesLegacySurface(
  claimType: BootstrapClaimType,
  extractedClaims: readonly ExtractedClaim[],
): { readonly matched: boolean; readonly matchedByCategory: boolean; readonly matchedByField: boolean } {
  const expectation = LEGACY_SURFACE_EXPECTATIONS[claimType];
  const matchedByCategory = extractedClaims.some((claim) => expectation.expectedCategories.includes(claim.category));
  const matchedByField = expectation.expectedFields === undefined
    ? false
    : extractedClaims.some((claim) => expectation.expectedFields.includes(claim.field));

  return {
    matched: matchedByCategory || matchedByField,
    matchedByCategory,
    matchedByField,
  };
}

export function analyzeRow(row: BootstrapClaimRow): RowAnalysis {
  const extractedClaims = extractClaims(row.shadowAnswerText);
  const legacyMatch = matchesLegacySurface(row.claim.type, extractedClaims);

  return {
    claimId: row.claimId,
    bootstrapType: row.claim.type,
    bootstrapCategory: row.claim.category,
    claimText: row.claim.text,
    shadowAnswerText: row.shadowAnswerText,
    expectedVerdict: row.expectedVerdict,
    matched: legacyMatch.matched,
    matchedByCategory: legacyMatch.matchedByCategory,
    matchedByField: legacyMatch.matchedByField,
    extractedClaims: extractedClaims.map((claim) => ({
      category: claim.category,
      field: claim.field,
      value: claim.value,
      normalizedValue: claim.normalizedValue,
    })),
  };
}

function makeAggregateBucket(rows: readonly RowAnalysis[]): AggregateBucket {
  const matched = rows.filter((row) => row.matched).length;
  return {
    total: rows.length,
    matched,
    unmatched: rows.length - matched,
  };
}

export function buildReport(commit: string, rows: readonly BootstrapClaimRow[]): AnalysisReport {
  const analyzed = rows.map(analyzeRow);
  const unmatchedRows = analyzed.filter((row) => !row.matched);

  const byBootstrapType = Object.fromEntries(
    (Object.keys(LEGACY_SURFACE_EXPECTATIONS) as BootstrapClaimType[]).map((type) => [
      type,
      makeAggregateBucket(analyzed.filter((row) => row.bootstrapType === type)),
    ]),
  ) as Record<BootstrapClaimType, AggregateBucket>;

  return {
    corpusRef: `${commit}:${GOLD_CLAIMS_PATH}`,
    totalRows: analyzed.length,
    matchedRows: analyzed.length - unmatchedRows.length,
    unmatchedRows: unmatchedRows.length,
    coverage: analyzed.length === 0 ? 0 : (analyzed.length - unmatchedRows.length) / analyzed.length,
    byBootstrapType,
    unmatchedRowsDetail: unmatchedRows,
    notes: [
      'This report is analysis-only. It does not restore ADR-016 grounded claims to runtime.',
      'Coverage means: the current deterministic legacy extractor emitted a surface compatible with the bootstrap claim type on the row.shadowAnswerText.',
      'Comparative/recommendation/drinking-window rows are expected to expose structural legacy gaps because the live extractor operates on five broad categories, not ADR-016 atomic types.',
    ],
  };
}

export function main(): void {
  const commit = parseArg('--commit') ?? DEFAULT_COMMIT;
  const out = parseArg('--out');
  const rows = loadHistoricalCorpus(commit);
  const report = buildReport(commit, rows);
  const serialized = JSON.stringify(report, null, 2);

  if (out !== undefined) {
    writeFileSync(resolvePath(out), serialized);
  }

  process.stdout.write(`${serialized}\n`);
}

const isCliEntrypoint = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (isCliEntrypoint) {
  main();
}
