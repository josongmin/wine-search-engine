import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { EntityRepository } from '../../domain/entity/port/entity-repository.port.js';
import type { Entity, EntityMetadata } from '../../domain/entity/model/entity.js';
import type { EntityType } from '../../domain/entity/model/entity-type.js';
import type { Relations } from '../../domain/entity/model/relations.js';
import type { EntityAttributes } from '../../domain/entity/model/attributes.js';
import { createEntityId, type EntityId } from '../../domain/shared/types/index.js';

interface EntityRow {
  entity_id: string;
  entity_type: string;
  canonical_label: string;
  identity_signature: string;
  relations: unknown;
  attributes: unknown;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

interface SnapshotRow {
  snapshot_id: string;
  entity_id: string;
  snapshot_data: unknown;
  created_at: Date;
}

function buildMetadata(metadata: Record<string, unknown>, row: EntityRow): EntityMetadata {
  const base: EntityMetadata = {
    createdAt: new Date((metadata['createdAt'] as string | undefined) ?? row.created_at),
    updatedAt: new Date((metadata['updatedAt'] as string | undefined) ?? row.updated_at),
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
  // Defensive JSONB validation: PostgreSQL JSONB columns can hold any JSON
  // scalar (string, number, array, etc.), not just objects. A bad ETL write
  // or schema drift can place a non-object value in `metadata`/`relations`/
  // `attributes`. Without these guards, downstream `for (... in obj)` /
  // `Object.entries(obj)` would either crash or silently iterate string
  // characters / array indices.
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const relations = isPlainObject(row.relations) ? (row.relations as Relations) : ({} as Relations);
  const attributes = isPlainObject(row.attributes)
    ? (row.attributes as EntityAttributes)
    : ({} as EntityAttributes);
  return {
    id: createEntityId(row.entity_id),
    type: row.entity_type as EntityType,
    canonicalLabel: row.canonical_label,
    identitySignature: row.identity_signature,
    relations,
    attributes,
    metadata: buildMetadata(metadata, row),
  };
}

export class PgEntityRepository implements EntityRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: EntityId): Promise<Entity | null> {
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE entity_id = $1',
      [id],
    );
    const row = result.rows[0];
    return row != null ? rowToEntity(row) : null;
  }

  async findBySignature(signature: string): Promise<Entity | null> {
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE identity_signature = $1',
      [signature],
    );
    const row = result.rows[0];
    return row != null ? rowToEntity(row) : null;
  }

  async findByType(type: EntityType, limit = 100): Promise<readonly Entity[]> {
    const result = await this.pool.query<EntityRow>(
      'SELECT * FROM entities WHERE entity_type = $1 ORDER BY created_at DESC LIMIT $2',
      [type, limit],
    );
    return result.rows.map(rowToEntity);
  }

  async save(entity: Entity): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO entities (
          entity_id, entity_type, canonical_label, identity_signature,
          relations, attributes, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (entity_id) DO UPDATE SET
          entity_type = EXCLUDED.entity_type,
          canonical_label = EXCLUDED.canonical_label,
          identity_signature = EXCLUDED.identity_signature,
          relations = EXCLUDED.relations,
          attributes = EXCLUDED.attributes,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at`,
        [
          entity.id,
          entity.type,
          entity.canonicalLabel,
          entity.identitySignature,
          JSON.stringify(entity.relations),
          JSON.stringify(entity.attributes),
          JSON.stringify(entity.metadata),
          entity.metadata.createdAt,
          entity.metadata.updatedAt,
        ],
      );
    } catch (err: unknown) {
      // PostgreSQL error code 23505 = unique_violation.
      // The entities table has a UNIQUE constraint on identity_signature in
      // addition to the PRIMARY KEY on entity_id.  The ON CONFLICT clause
      // above only handles entity_id conflicts; a conflicting identity_signature
      // on a *different* entity_id will throw here.  Re-throw with context so
      // callers can distinguish constraint violations from other DB errors.
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === '23505'
      ) {
        throw new Error(
          `Entity save failed: identity_signature "${entity.identitySignature}" already exists for a different entity (entity_id="${String(entity.id)}"). Original: ${err.message}`,
        );
      }
      throw err;
    }
  }

  async update(entity: Entity): Promise<void> {
    const result = await this.pool.query(
      `UPDATE entities SET
        entity_type = $2,
        canonical_label = $3,
        identity_signature = $4,
        relations = $5,
        attributes = $6,
        metadata = $7,
        updated_at = $8
      WHERE entity_id = $1`,
      [
        entity.id,
        entity.type,
        entity.canonicalLabel,
        entity.identitySignature,
        JSON.stringify(entity.relations),
        JSON.stringify(entity.attributes),
        JSON.stringify(entity.metadata),
        entity.metadata.updatedAt,
      ],
    );
    // Surface silent no-ops: an update against a non-existent entity_id
    // returns rowCount=0, not an error. Callers expect a successful update
    // to mean the row exists; otherwise they'd use upsert (save()).
    if (result.rowCount === 0) {
      throw new Error(`Entity update failed: no row found for entity_id="${String(entity.id)}"`);
    }
  }

  async delete(id: EntityId): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM entities WHERE entity_id = $1',
      [id],
    );
    if (result.rowCount === 0) {
      throw new Error(`Entity delete failed: no row found for entity_id="${String(id)}"`);
    }
  }

  async createSnapshot(label: string): Promise<string> {
    const snapshotId = nanoid();
    // Snapshot all current entities as a JSON array stored once per snapshot
    const entitiesResult = await this.pool.query<EntityRow>('SELECT * FROM entities');
    const snapshotData = {
      label,
      createdAt: new Date().toISOString(),
      entities: entitiesResult.rows,
    };

    // Store one snapshot_id row per entity for per-entity rollback support
    // Use a single row with a sentinel entity_id approach: store aggregate snapshot
    // pointing to the first entity (or use a special aggregate record).
    // Per the schema, entity_snapshots requires entity_id FK. We store one row per entity.
    if (entitiesResult.rows.length === 0) {
      // No entities to snapshot; store metadata only in decision_snapshots
      await this.pool.query(
        `INSERT INTO decision_snapshots (snapshot_id, snapshot_data)
         VALUES ($1, $2)`,
        [snapshotId, JSON.stringify({ ...snapshotData, type: 'entity_store_snapshot' })],
      );
      return snapshotId;
    }

    // Store per-entity snapshots so rollback can restore individual entities
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of entitiesResult.rows) {
        const rowSnapshotId = `${snapshotId}:${row.entity_id}`;
        await client.query(
          `INSERT INTO entity_snapshots (snapshot_id, entity_id, snapshot_data)
           VALUES ($1, $2, $3)`,
          [rowSnapshotId, row.entity_id, JSON.stringify(row)],
        );
      }
      // Also store the aggregate metadata for lookup
      await client.query(
        `INSERT INTO decision_snapshots (snapshot_id, snapshot_data)
         VALUES ($1, $2)`,
        [snapshotId, JSON.stringify({ ...snapshotData, type: 'entity_store_snapshot', entities: undefined })],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return snapshotId;
  }

  async rollbackToSnapshot(snapshotId: string): Promise<void> {
    // Retrieve all per-entity snapshots for this snapshotId
    const snapResult = await this.pool.query<SnapshotRow>(
      `SELECT * FROM entity_snapshots WHERE snapshot_id LIKE $1 ORDER BY created_at ASC`,
      [`${snapshotId.replace(/[%_\\]/g, '\\$&')}:%`],
    );

    if (snapResult.rows.length === 0) {
      throw new Error(`No entity snapshots found for snapshotId: ${snapshotId}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Collect entity_ids that were part of this snapshot
      const snapshotEntityIds = new Set<string>();
      for (const snap of snapResult.rows) {
        const data = snap.snapshot_data as EntityRow;
        snapshotEntityIds.add(data.entity_id);

        // Restore entity to its snapshotted state
        await client.query(
          `INSERT INTO entities (
            entity_id, entity_type, canonical_label, identity_signature,
            relations, attributes, metadata, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (entity_id) DO UPDATE SET
            entity_type = EXCLUDED.entity_type,
            canonical_label = EXCLUDED.canonical_label,
            identity_signature = EXCLUDED.identity_signature,
            relations = EXCLUDED.relations,
            attributes = EXCLUDED.attributes,
            metadata = EXCLUDED.metadata,
            updated_at = EXCLUDED.updated_at`,
          [
            data.entity_id,
            data.entity_type,
            data.canonical_label,
            data.identity_signature,
            typeof data.relations === 'string' ? data.relations : JSON.stringify(data.relations),
            typeof data.attributes === 'string' ? data.attributes : JSON.stringify(data.attributes),
            typeof data.metadata === 'string' ? data.metadata : JSON.stringify(data.metadata),
            data.created_at,
            data.updated_at,
          ],
        );
      }

      // Delete entities that did not exist at snapshot time
      const idList = Array.from(snapshotEntityIds);
      if (idList.length > 0) {
        const placeholders = idList.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `DELETE FROM entities WHERE entity_id NOT IN (${placeholders})`,
          idList,
        );
      } else {
        await client.query('DELETE FROM entities');
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
