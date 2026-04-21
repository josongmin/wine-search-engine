import type { Pool } from 'pg';

const columnCapabilityCache = new WeakMap<Pool, Map<string, Promise<boolean>>>();

function makeCapabilityKey(tableName: string, columnName: string): string {
  return `${tableName}::${columnName}`;
}

export async function pgTableHasColumn(
  pool: Pool,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  let poolCache = columnCapabilityCache.get(pool);
  if (poolCache === undefined) {
    poolCache = new Map<string, Promise<boolean>>();
    columnCapabilityCache.set(pool, poolCache);
  }

  const cacheKey = makeCapabilityKey(tableName, columnName);
  const cached = poolCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const probe = pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1
         AND column_name = $2
     ) AS present`,
    [tableName, columnName],
  ).then((result) => result.rows[0]?.present === true);

  poolCache.set(cacheKey, probe);
  return probe;
}
