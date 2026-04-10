import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// BUG-18: migration 005 duplicate 정리 없이 CREATE UNIQUE INDEX → 프로덕션 배포 블로커
//
// 이 테스트는 migration SQL 파일의 구조적 correctness를 검증한다.
// 실제 DB 연결 없이 SQL 텍스트를 파싱하여 필수 순서와 내용을 강제한다:
//   1. CREATE UNIQUE INDEX 전에 중복 제거 CTE가 존재해야 함
//   2. ROW_NUMBER() OVER (PARTITION BY ...) 패턴으로 중복을 정확히 식별해야 함
//   3. DELETE 문이 CTE 이후, CREATE INDEX 이전에 위치해야 함

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../../../src/infrastructure/db/migrations/005_watchlist_dedup_constraint.sql',
);

describe('migration 005 — watchlist dedup constraint (BUG-18)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  // Strip single-line comments so comment text doesn't confuse position checks
  const sqlStripped = sql.replace(/--[^\n]*/g, '');
  const sqlNormalized = sqlStripped.replace(/\s+/g, ' ').toLowerCase();

  it('contains a duplicate-cleanup CTE before CREATE UNIQUE INDEX', () => {
    const ctaIndex = sqlNormalized.indexOf('with ranked as');
    const createIndex = sqlNormalized.indexOf('create unique index');
    expect(ctaIndex, 'WITH ranked AS CTE must exist').toBeGreaterThan(-1);
    expect(createIndex, 'CREATE UNIQUE INDEX must exist').toBeGreaterThan(-1);
    expect(ctaIndex, 'CTE must come BEFORE CREATE UNIQUE INDEX').toBeLessThan(createIndex);
  });

  it('uses ROW_NUMBER() OVER PARTITION BY to identify duplicates', () => {
    expect(sqlNormalized).toContain('row_number()');
    expect(sqlNormalized).toContain('partition by user_id, entity_id, callback_url');
  });

  it('deletes duplicate rows (keeps only rn = 1)', () => {
    expect(sqlNormalized).toContain('delete from watchlists');
    expect(sqlNormalized).toContain('rn > 1');
  });

  it('creates the correct index name on the correct columns', () => {
    expect(sqlNormalized).toContain('idx_watchlists_user_entity_callback');
    expect(sqlNormalized).toContain('on watchlists (user_id, entity_id, callback_url)');
  });

  it('uses IF NOT EXISTS to be idempotent on re-run', () => {
    expect(sqlNormalized).toContain('create unique index if not exists');
  });

  it('DELETE occurs before CREATE UNIQUE INDEX in the file', () => {
    const deleteIndex = sqlNormalized.indexOf('delete from watchlists');
    const createIndex = sqlNormalized.indexOf('create unique index');
    expect(deleteIndex, 'DELETE must exist').toBeGreaterThan(-1);
    expect(deleteIndex, 'DELETE must come before CREATE UNIQUE INDEX').toBeLessThan(createIndex);
  });
});
