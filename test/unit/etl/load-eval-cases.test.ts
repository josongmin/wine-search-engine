import { describe, expect, it } from 'vitest';
import {
  buildEvalCasesUpsertStatement,
  createLoadEvalCasesPool,
  resolveLoadEvalCasesPgConfig,
} from '../../../scripts/etl/load-eval-cases.js';

describe('load-eval-cases pg bootstrap', () => {
  it('inherits the repo pg SSL policy while allowing a CLI connection-string override', async () => {
    const connectionString = 'postgresql://wine:secret@example.com:5432/wine_engine';
    const pgConfig = resolveLoadEvalCasesPgConfig(connectionString);

    expect(pgConfig.connectionString).toBe(connectionString);
    expect(typeof pgConfig.ssl).toBe('boolean');

    const pool = createLoadEvalCasesPool(connectionString);
    try {
      expect(pool.options.connectionString).toBe(connectionString);
      if (pgConfig.ssl) {
        expect(pool.options.ssl).toEqual({ rejectUnauthorized: pgConfig.sslRejectUnauthorized });
      }
    } finally {
      await pool.end();
    }
  });

  it('downgrades the eval_cases upsert shape when refresh metadata columns are absent', () => {
    const legacy = buildEvalCasesUpsertStatement({
      hasSourceCorpusHash: false,
      hasRefreshedAt: false,
    });
    expect(legacy.sql).not.toContain('source_corpus_hash');
    expect(legacy.sql).not.toContain('refreshed_at');

    const refreshedOnly = buildEvalCasesUpsertStatement({
      hasSourceCorpusHash: false,
      hasRefreshedAt: true,
    });
    expect(refreshedOnly.sql).toContain('refreshed_at');
    expect(refreshedOnly.sql).not.toContain('source_corpus_hash');
  });
});
