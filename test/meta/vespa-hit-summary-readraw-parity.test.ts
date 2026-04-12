import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VESPA_READ_RAW_RETRIEVAL_SUMMARY_FIELD_NAMES } from '../../src/infrastructure/vespa/mapping.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function extractDocumentSummaryBlock(sdText: string, summaryName: string): string {
  const marker = `document-summary ${summaryName}`;
  const start = sdText.indexOf(marker);
  expect(start, `${summaryName} block not found`).toBeGreaterThan(-1);
  const braceStart = sdText.indexOf('{', start);
  expect(braceStart, `${summaryName} opening brace`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = braceStart; i < sdText.length; i += 1) {
    const ch = sdText.charAt(i);
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return sdText.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unclosed document-summary ${summaryName}`);
}

describe('Vespa hit_summary ↔ readRawVespaRetrievalSummary SSoT', () => {
  it('wine_entity.sd hit_summary lists every field read by readRawVespaRetrievalSummary', () => {
    const sdPath = path.join(REPO_ROOT, 'vespa/app/schemas/wine_entity.sd');
    const raw = fs.readFileSync(sdPath, 'utf8');
    const hitBlock = extractDocumentSummaryBlock(raw, 'hit_summary');
    expect(hitBlock).toContain('summary entity_id {}');
    for (const field of VESPA_READ_RAW_RETRIEVAL_SUMMARY_FIELD_NAMES) {
      expect(hitBlock, `hit_summary missing summary for ${field}`).toContain(`summary ${field} {}`);
    }
  });

  it('vespa-schema.sd hit_summary mirror lists the same retrieval summary fields', () => {
    const sdPath = path.join(REPO_ROOT, 'src/infrastructure/vespa/vespa-schema.sd');
    const raw = fs.readFileSync(sdPath, 'utf8');
    const hitBlock = extractDocumentSummaryBlock(raw, 'hit_summary');
    expect(hitBlock).toContain('summary entity_id {}');
    for (const field of VESPA_READ_RAW_RETRIEVAL_SUMMARY_FIELD_NAMES) {
      expect(hitBlock, `vespa-schema.sd hit_summary missing summary for ${field}`).toContain(
        `summary ${field} {}`,
      );
    }
  });
});
