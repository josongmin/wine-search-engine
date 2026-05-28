import { isQueryClass, type QueryClass } from '../../shared/types/query-class.js';

const EXACT_LOOKUP_RUNTIME_CLASSES = new Set<QueryClass>([
  'exact_entity',
  'short_entity',
]);

/**
 * Golden-corpus query classes and runtime planner query classes are not a
 * strict equality relation.
 *
 * - `exact_entity` gold labels legitimately execute as `short_entity`.
 * - corpus-only labels that are outside the runtime query-class vocabulary do
 *   not carry a planner-class assertion and therefore cannot declare mismatch.
 */
export function isGoldRuntimeQueryClassMismatch(
  goldQueryClass: string,
  runtimeQueryClass: QueryClass,
): boolean {
  if (!isQueryClass(goldQueryClass)) {
    return false;
  }

  if (goldQueryClass === 'exact_entity' || goldQueryClass === 'short_entity') {
    return !EXACT_LOOKUP_RUNTIME_CLASSES.has(runtimeQueryClass);
  }

  return goldQueryClass !== runtimeQueryClass;
}
