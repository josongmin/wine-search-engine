/**
 * Regression: Entity type validation hard-fail behavior.
 *
 * Verifies that:
 *   1. Valid entity types pass the isEntityType guard
 *   2. Invalid entity types cause rowToEntity to throw (via PgEntityRepository)
 *   3. No silent coercion to a default type (e.g. 'wine') occurs
 *
 * Tests the guard at the domain layer (isEntityType + ENTITY_TYPES) and
 * exercises the full rowToEntity path through PgEntityRepository.findById
 * with a mocked pool.
 */
import { describe, it, expect, vi } from 'vitest';
import { isEntityType, ENTITY_TYPES } from '../../src/domain/entity/model/entity-type.js';
import { PgEntityRepository } from '../../src/infrastructure/adapter/pg-entity-repository.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import { NoActiveSnapshotPointerError } from '../../src/infrastructure/db/active-snapshot-resolver.js';

// ---------------------------------------------------------------------------
// Pool mock factory — returns a single EntityRow for findById
// ---------------------------------------------------------------------------

function createMockPool(entityType: string) {
  const activeSnapshotRow = {
    active_snapshot_id: 'search-snapshot:v1:test',
    previous_snapshot_id: null,
    content_hash: 'hash:test',
    promoted_at: new Date(),
  };
  const row = {
    entity_id: 'wine:test-123',
    entity_type: entityType,
    canonical_label: 'Test Wine',
    identity_signature: 'sig:test-123',
    relations: {},
    attributes: {},
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM active_search_snapshot')) {
        return {
          rows: [activeSnapshotRow],
          rowCount: 1,
        };
      }
      return {
        rows: [row],
        rowCount: 1,
      };
    }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

function createEmptyMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

describe('entity type hard-fail validation (regression)', () => {
  // -------------------------------------------------------------------------
  // Domain guard: isEntityType
  // -------------------------------------------------------------------------

  describe('isEntityType guard', () => {
    it.each(ENTITY_TYPES)('accepts valid entity type "%s"', (type) => {
      expect(isEntityType(type)).toBe(true);
    });

    it('ENTITY_TYPES contains the expected canonical types', () => {
      expect(ENTITY_TYPES).toContain('wine');
      expect(ENTITY_TYPES).toContain('producer');
      expect(ENTITY_TYPES).toContain('region');
      expect(ENTITY_TYPES).toContain('vintage');
      expect(ENTITY_TYPES).toContain('grape');
    });

    it('rejects "invalid"', () => {
      expect(isEntityType('invalid')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isEntityType('')).toBe(false);
    });

    it('rejects uppercase variants (no case coercion)', () => {
      expect(isEntityType('Wine')).toBe(false);
      expect(isEntityType('WINE')).toBe(false);
      expect(isEntityType('Producer')).toBe(false);
    });

    it('rejects whitespace-padded types (no trim coercion)', () => {
      expect(isEntityType(' wine')).toBe(false);
      expect(isEntityType('wine ')).toBe(false);
      expect(isEntityType(' wine ')).toBe(false);
    });

    it('rejects similar but wrong strings', () => {
      expect(isEntityType('wines')).toBe(false);
      expect(isEntityType('producers')).toBe(false);
      expect(isEntityType('regions')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // PgEntityRepository.findById — entity_type validation through rowToEntity
  // -------------------------------------------------------------------------

  describe('PgEntityRepository entity_type validation', () => {
    it.each(['wine', 'producer', 'region', 'vintage', 'grape'] as const)(
      'valid entity_type "%s" passes through rowToEntity without error',
      async (type) => {
        const pool = createMockPool(type);
         
        const repo = new PgEntityRepository(pool as never);
        const testId = createCanonicalEntityId('wine:test-123');

        const entity = await repo.findById(testId);
        expect(entity).not.toBeNull();
        expect(entity!.type).toBe(type);
      },
    );

    it('invalid entity_type "invalid" throws with descriptive error', async () => {
      const pool = createMockPool('invalid');
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:test-123');

      await expect(repo.findById(testId)).rejects.toThrow('invalid entity_type');
    });

    it('invalid entity_type error message contains the valid types', async () => {
      const pool = createMockPool('bogus');
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:test-123');

      await expect(repo.findById(testId)).rejects.toThrow(
        /wine.*producer.*region/,
      );
    });

    it('empty string entity_type throws', async () => {
      const pool = createMockPool('');
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:test-123');

      await expect(repo.findById(testId)).rejects.toThrow('invalid entity_type');
    });

    it('no silent coercion to "wine" default — uppercase "Wine" throws', async () => {
      const pool = createMockPool('Wine');
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:test-123');

      // If coercion existed, this would silently succeed with type='wine'.
      // The test verifies it throws instead.
      await expect(repo.findById(testId)).rejects.toThrow('invalid entity_type');
    });

    it('no silent coercion — null-ish entity_type from corrupted row throws', async () => {
      // Simulate a row where entity_type column is somehow null (DB corruption)
      const activeSnapshotRow = {
        active_snapshot_id: 'search-snapshot:v1:test',
        previous_snapshot_id: null,
        content_hash: 'hash:test',
        promoted_at: new Date(),
      };
      const pool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM active_search_snapshot')) {
            return {
              rows: [activeSnapshotRow],
              rowCount: 1,
            };
          }
          return {
            rows: [{
              entity_id: 'wine:test-null',
              entity_type: null,
              canonical_label: 'Test',
              identity_signature: 'sig:test-null',
              relations: {},
              attributes: {},
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            }],
            rowCount: 1,
          };
        }),
        connect: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:test-null');

      // null is not a valid entity type — must throw, not default to 'wine'
      await expect(repo.findById(testId)).rejects.toThrow();
    });

    it('findById fails loud when active snapshot pointer is missing', async () => {
      const pool = createEmptyMockPool();
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:nonexistent');

      await expect(repo.findById(testId)).rejects.toBeInstanceOf(NoActiveSnapshotPointerError);
    });

    it('findById returns null when pointer exists but entity row is missing', async () => {
      const activeSnapshotRow = {
        active_snapshot_id: 'search-snapshot:v1:test',
        previous_snapshot_id: null,
        content_hash: 'hash:test',
        promoted_at: new Date(),
      };
      const pool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM active_search_snapshot')) {
            return {
              rows: [activeSnapshotRow],
              rowCount: 1,
            };
          }
          return {
            rows: [],
            rowCount: 0,
          };
        }),
        connect: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:nonexistent');

      const result = await repo.findById(testId);
      expect(result).toBeNull();
    });

    it('error message includes the offending entity_id for debugging', async () => {
      const activeSnapshotRow = {
        active_snapshot_id: 'search-snapshot:v1:test',
        previous_snapshot_id: null,
        content_hash: 'hash:test',
        promoted_at: new Date(),
      };
      const pool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM active_search_snapshot')) {
            return {
              rows: [activeSnapshotRow],
              rowCount: 1,
            };
          }
          return {
            rows: [{
              entity_id: 'wine:debug-entity-456',
              entity_type: 'not-a-type',
              canonical_label: 'Debug',
              identity_signature: 'sig:debug',
              relations: {},
              attributes: {},
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            }],
            rowCount: 1,
          };
        }),
        connect: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };
       
      const repo = new PgEntityRepository(pool as never);
      const testId = createCanonicalEntityId('wine:debug-entity-456');

      await expect(repo.findById(testId)).rejects.toThrow('wine:debug-entity-456');
    });
  });
});
