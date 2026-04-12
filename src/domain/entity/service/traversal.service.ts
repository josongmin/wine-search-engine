import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { Entity } from '../model/entity.js';
import type { EntityRepository } from '../port/entity-repository.port.js';

/**
 * Options controlling the graph traversal behaviour.
 */
export interface TraversalOptions {
  /** Maximum number of hops from the start node. Default: 2 */
  readonly maxHops?: number;
  /** Maximum number of neighbours to expand per node. Default: 50 */
  readonly maxFanOut?: number;
  /** Wall-clock timeout in milliseconds. Default: 500 */
  readonly timeoutMs?: number;
  /** If specified, only follow these relation types. */
  readonly relationTypes?: readonly string[];
}

/**
 * Represents a single edge discovered during traversal.
 */
export interface TraversalEdge {
  readonly fromId: CanonicalEntityId;
  readonly toId: CanonicalEntityId;
  readonly relationType: string;
  readonly hop: number;
}

/**
 * The result of a graph traversal.
 */
export interface TraversalResult {
  /** All entities discovered (including the start entity). */
  readonly entities: ReadonlyMap<CanonicalEntityId, Entity>;
  /** All edges followed during traversal. */
  readonly edges: readonly TraversalEdge[];
  /** Whether the traversal was cut short by time or fan-out limits. */
  readonly truncated: boolean;
}

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_FAN_OUT = 50;
const DEFAULT_TIMEOUT_MS = 500;

/**
 * Graph traversal service implementing RFC-001 §2.2.1 Runtime Traversal Budget.
 *
 * Performs breadth-first traversal from a start entity, respecting:
 * - Maximum hop depth (default 2)
 * - Maximum fan-out per node (default 50)
 * - Wall-clock timeout (default 500ms)
 */
export class TraversalService {
  constructor(private readonly entityRepo: EntityRepository) {}

  /**
   * Traverse the entity graph starting from the given entity id.
   *
   * @param startId - The entity to start traversal from.
   * @param options - Optional traversal budget constraints.
   * @returns A TraversalResult containing discovered entities and edges.
   */
  async traverse(startId: CanonicalEntityId, options?: TraversalOptions): Promise<TraversalResult> {
    const maxHops = options?.maxHops ?? DEFAULT_MAX_HOPS;
    const maxFanOut = options?.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const relationFilter = options?.relationTypes
      ? new Set(options.relationTypes)
      : null;

    const deadline = Date.now() + timeoutMs;
    const visited = new Map<CanonicalEntityId, Entity>();
    const edges: TraversalEdge[] = [];
    let truncated = false;

    // BFS queue: [entityId, currentHop]
    const queue: Array<[CanonicalEntityId, number]> = [[startId, 0]];

    while (queue.length > 0) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }

      const next = queue.shift();
      if (!next) break;
      const [currentId, hop] = next;

      if (visited.has(currentId)) continue;

      const entity = await this.entityRepo.findById(currentId);
      if (!entity) continue;

      visited.set(currentId, entity);

      // Don't expand neighbours beyond maxHops
      if (hop >= maxHops) continue;

      const neighbours = this.extractNeighbours(entity, relationFilter);
      let fanOutCount = 0;

      for (const { id: neighbourId, relationType } of neighbours) {
        if (fanOutCount >= maxFanOut) {
          truncated = true;
          break;
        }
        if (visited.has(neighbourId)) continue;

        edges.push({
          fromId: currentId,
          toId: neighbourId,
          relationType,
          hop: hop + 1,
        });

        queue.push([neighbourId, hop + 1]);
        fanOutCount++;
      }
    }

    return { entities: visited, edges, truncated };
  }

  /**
   * Extracts neighbour ids and relation types from an entity's relations.
   */
  private extractNeighbours(
    entity: Entity,
    relationFilter: ReadonlySet<string> | null,
  ): Array<{ id: CanonicalEntityId; relationType: string }> {
    const result: Array<{ id: CanonicalEntityId; relationType: string }> = [];

    const relationEntries: Array<[string, CanonicalEntityId | undefined]> = [
      ['producedBy', entity.relations.producedBy],
      ['variantOf', entity.relations.variantOf],
      ['locatedIn', entity.relations.locatedIn],
    ];

    for (const [relationType, targetId] of relationEntries) {
      if (!targetId) continue;
      if (relationFilter && !relationFilter.has(relationType)) continue;
      result.push({ id: targetId, relationType });
    }

    return result;
  }
}
