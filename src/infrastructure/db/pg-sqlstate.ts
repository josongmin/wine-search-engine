/**
 * Reads PostgreSQL driver `code` (SQLSTATE) from thrown errors without
 * type assertions — `pg` attaches `code` to Error-like objects.
 */
export function readPgSqlState(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code: unknown = Reflect.get(err, 'code');
  return typeof code === 'string' ? code : undefined;
}
