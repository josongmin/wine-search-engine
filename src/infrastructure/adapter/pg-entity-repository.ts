import type { Pool } from 'pg';
import type { EntityRepository } from '../../domain/entity/port/entity-repository.port.js';
import type { Entity, EntityMetadata } from '../../domain/entity/model/entity.js';
import type { EntityType } from '../../domain/entity/model/entity-type.js';
import { isEntityType, ENTITY_TYPES } from '../../domain/entity/model/entity-type.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../domain/shared/types/index.js';
import {
  parseRelationsJsonb,
  parseEntityAttributesJsonb,
} from './jsonb-schemas.js';
import { resolveActiveSnapshot } from '../db/active-snapshot-resolver.js';

const ROW_TO_ENTITY_CALLER = 'PgEntityRepository.rowToEntity';

/**
 * Safety limit for SELECT * FROM entities.
 * Prevents unbounded full-table scans.
 */
const ENTITY_FETCH_DEFAULT_LIMIT = 10_000;

/**
 * Row shape returned by `SELECT * FROM entities`. Exported so regression tests
 * can assert the type declares `search_snapshot_id`, which is required for
 * any snapshot-scoped query to type-check against the real table.
 *
 * Intentional: this type mirrors the physical row shape, not the domain
 * `Entity` model. `rowToEntity()` drops `search_snapshot_id` because the
 * domain model is snapshot-agnostic — a single request runs under a single
 * active snapshot.
 */
export interface EntityRow {
  readonly entity_id: string;
  readonly search_snapshot_id: string;
  readonly entity_type: string;
  readonly canonical_label: string;
  readonly identity_signature: string;
  readonly relations: unknown;
  readonly attributes: unknown;
  readonly metadata: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Parse a JSONB date string, falling back to the PG row timestamp on invalid input. */
function parseDateOrFallback(raw: unknown, fallback: Date): Date {
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime())) return d;
  }
  return new Date(fallback);
}

function buildMetadata(metadata: Record<string, unknown>, row: EntityRow): EntityMetadata {
  const base: EntityMetadata = {
    createdAt: parseDateOrFallback(metadata['createdAt'], row.created_at),
    updatedAt: parseDateOrFallback(metadata['updatedAt'], row.updated_at),
  };
  const source = metadata['source'];
  const trustRaw = metadata['trustTier'];
  const tier =
    trustRaw === 'high' || trustRaw === 'medium' || trustRaw === 'low' ? trustRaw : undefined;
  if (typeof source === 'string' && tier !== undefined) {
    return { ...base, source, trustTier: tier };
  }
  if (typeof source === 'string') {
    return { ...base, source };
  }
  if (tier !== undefined) {
    return { ...base, trustTier: tier };
  }
  return base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rowToEntity(row: EntityRow): Entity {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const relations = parseRelationsJsonb(row.relations, ROW_TO_ENTITY_CALLER);
  const attributes = parseEntityAttributesJsonb(row.attributes, ROW_TO_ENTITY_CALLER);
  if (!isEntityType(row.entity_type)) {
    throw new Error(
      `PgEntityRepository: invalid entity_type "${row.entity_type}" for entity_id="${row.entity_id}". ` +
      `Expected one of: ${ENTITY_TYPES.join(', ')}`,
    );
  }
  const entityType: EntityType = row.entity_type;
  return {
    id: createCanonicalEntityId(row.entity_id),
    type: entityType,
    canonicalLabel: row.canonical_label,
    identitySignature: row.identity_signature,
    relations,
    attributes,
    metadata: buildMetadata(metadata, row),
  };
}

export class PgEntityRepository implements EntityRepository {
  constructor(private readonly pool: Pool) {}

  private async resolveActiveSnapshotId(): Promise<string> {
    const { activeSnapshotId } = await resolveActiveSnapshot(this.pool);
    return activeSnapshotId;
  }

  async findById(id: CanonicalEntityId): Promise<Entity | null> {
    const activeSnapshotId = await this.resolveActiveSnapshotId();
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE entity_id = $1 AND search_snapshot_id = $2',
      [id, activeSnapshotId],
    );
    const row = result.rows[0];
    return row ? rowToEntity(row) : null;
  }

  async findBySignature(signature: string): Promise<Entity | null> {
    const activeSnapshotId = await this.resolveActiveSnapshotId();
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE identity_signature = $1 AND search_snapshot_id = $2',
      [signature, activeSnapshotId],
    );
    const row = result.rows[0];
    return row ? rowToEntity(row) : null;
  }

  async findByType(type: EntityType, limit: number = ENTITY_FETCH_DEFAULT_LIMIT): Promise<readonly Entity[]> {
    const activeSnapshotId = await this.resolveActiveSnapshotId();
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE entity_type = $1 AND search_snapshot_id = $2 ORDER BY created_at DESC LIMIT $3',
      [type, activeSnapshotId, limit],
    );
    return result.rows.map(rowToEntity);
  }
}
