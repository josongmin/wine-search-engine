/**
 * Wine KG seed loader (Epic-11).
 *
 * Reads the canonical entity ontology snapshot (`data/entity-ontology.json`)
 * and materializes a {@link WineKG}: a typed, immutable graph of wine-domain
 * entities with `is_a` / `part_of` edges suitable for entity resolution,
 * compositional inference, and ontology expansion.
 *
 * Design notes:
 * - The loader accepts ontology snapshots that expose either the keyed
 *   `entities` map (preferred — canonical IDs) or the flat `nodes` array
 *   (legacy fallback). Both shapes are validated with Zod.
 * - Node types are mapped from ontology entity types into the narrower
 *   {@link WineKGNodeType} vocabulary (e.g. `grape_primary` → `grape`).
 *   Unknown entity types are skipped with a warning.
 * - Region edges are built from the entity `hierarchy`/`parent` fields
 *   (ID-resolved via a canonical-label index) and cross-checked against
 *   the top-level `regionHierarchy` label map.
 * - Orphan edges (endpoints missing from the node set) are dropped with a
 *   warning rather than failing the load — the snapshot is a seed, and
 *   downstream consumers treat missing edges as a soft signal.
 * - Cycles in `is_a` / `part_of` chains are a hard error: they break
 *   ancestor traversal and compositional inference, so we throw with the
 *   full cycle path in the message.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import type {
  WineKG,
  WineKGEdge,
  WineKGNode,
  WineKGNodeType,
} from '../model/wine-kg.js';

/** Known node types we materialize from the ontology snapshot. */
const KNOWN_NODE_TYPES: ReadonlySet<WineKGNodeType> = new Set<WineKGNodeType>([
  'wine',
  'producer',
  'region',
  'sub_region',
  'appellation',
  'country',
  'grape',
  'grape_family',
  'wine_type',
  'style',
  'occasion',
]);

/**
 * Mapping from ontology snapshot entity types to the narrower KG node type
 * vocabulary. Entities whose type is not in this map are skipped.
 */
const ENTITY_TYPE_MAP: Readonly<Record<string, WineKGNodeType>> = {
  wine: 'wine',
  producer: 'producer',
  region: 'region',
  sub_region: 'sub_region',
  subregion: 'sub_region',
  appellation: 'appellation',
  country: 'country',
  grape: 'grape',
  grape_primary: 'grape',
  grape_family: 'grape_family',
  wine_type: 'wine_type',
  style: 'style',
  occasion: 'occasion',
};

/** Default snapshot path relative to process cwd. */
const DEFAULT_SNAPSHOT_PATH = 'data/entity-ontology.json';

/** Maximum Zod validation issues to include in the error message. */
const MAX_ZOD_ISSUES_IN_MESSAGE = 5;

/** Entity as it appears in the keyed `entities` map (preferred shape). */
const KeyedEntitySchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    canonical: z.string().min(1),
    parent: z.string().nullable().optional(),
    hierarchy: z.array(z.string()).optional(),
    aliases: z.array(z.string()).default([]),
  })
  .passthrough();

/** Entity as it appears in the flat `nodes` array (legacy shape). */
const ArrayEntitySchema = z
  .object({
    id: z.string().min(1),
    entityType: z.string().min(1),
    canonicalLabel: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    parents: z.array(z.string()).optional(),
  })
  .passthrough();

const SnapshotSchema = z
  .object({
    version: z.string().optional(),
    entities: z.record(KeyedEntitySchema).optional(),
    nodes: z.array(ArrayEntitySchema).optional(),
    regionHierarchy: z.record(z.string()).optional(),
    grapeAliases: z.record(z.string()).optional(),
    wineTypeAliases: z.record(z.string()).optional(),
  })
  .passthrough();

type Snapshot = z.infer<typeof SnapshotSchema>;

export interface LoadSeedKGOptions {
  readonly filePath?: string;
}

/**
 * Read and parse the ontology snapshot from disk, then materialize a WineKG.
 * Defaults to `data/entity-ontology.json` relative to the current working
 * directory.
 */
export async function loadSeedKG(
  options: LoadSeedKGOptions = {},
): Promise<WineKG> {
  const filePath = resolve(options.filePath ?? DEFAULT_SNAPSHOT_PATH);
  const raw = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[wine-kg-loader] failed to parse ${filePath} as JSON: ${(err as Error).message}`,
    );
  }
  return buildSeedKGFromSnapshot(parsed);
}

/**
 * Build a WineKG from an in-memory snapshot object. Exported separately so
 * tests and downstream tools can exercise the validation/edge-building logic
 * without touching the filesystem.
 */
export function buildSeedKGFromSnapshot(snapshot: unknown): WineKG {
  const result = SnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, MAX_ZOD_ISSUES_IN_MESSAGE)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `[wine-kg-loader] invalid ontology snapshot: ${issues}`,
    );
  }
  const snap = result.data;
  const nodes = buildNodes(snap);
  const labelIndex = buildLabelIndex(nodes);
  const edges = buildEdges(snap, nodes, labelIndex);
  assertAcyclic(nodes, edges);
  return {
    version: snap.version ?? 'unknown',
    nodes,
    edges,
  };
}

function buildNodes(snap: Snapshot): ReadonlyMap<string, WineKGNode> {
  const out = new Map<string, WineKGNode>();

  if (snap.entities !== undefined) {
    for (const [id, ent] of Object.entries(snap.entities)) {
      const mappedType = ENTITY_TYPE_MAP[ent.type];
      if (mappedType === undefined || !KNOWN_NODE_TYPES.has(mappedType)) {
        bootstrapLogger.warn(
          { id, entityType: ent.type },
          '[wine-kg-loader] skipping entity with unknown type',
        );
        continue;
      }
      out.set(id, {
        id,
        type: mappedType,
        canonical: ent.canonical,
        aliases: Object.freeze([...ent.aliases]),
      });
    }
  } else if (snap.nodes !== undefined) {
    for (const ent of snap.nodes) {
      const mappedType = ENTITY_TYPE_MAP[ent.entityType];
      if (mappedType === undefined || !KNOWN_NODE_TYPES.has(mappedType)) {
        bootstrapLogger.warn(
          { id: ent.id, entityType: ent.entityType },
          '[wine-kg-loader] skipping entity with unknown type',
        );
        continue;
      }
      out.set(ent.id, {
        id: ent.id,
        type: mappedType,
        canonical: ent.canonicalLabel,
        aliases: Object.freeze([...ent.aliases]),
      });
    }
  }

  return out;
}

/**
 * Index every node by its canonical label AND every alias (lowercased) so
 * that hierarchy strings from the snapshot — which are labels, not IDs —
 * can be resolved to node IDs. Collisions prefer the first insertion.
 */
function buildLabelIndex(
  nodes: ReadonlyMap<string, WineKGNode>,
): ReadonlyMap<string, string> {
  const idx = new Map<string, string>();
  for (const [id, node] of nodes) {
    const canonicalKey = node.canonical.toLowerCase();
    if (!idx.has(canonicalKey)) idx.set(canonicalKey, id);
    for (const alias of node.aliases) {
      const aliasKey = alias.toLowerCase();
      if (!idx.has(aliasKey)) idx.set(aliasKey, id);
    }
  }
  return idx;
}

function buildEdges(
  snap: Snapshot,
  nodes: ReadonlyMap<string, WineKGNode>,
  labelIndex: ReadonlyMap<string, string>,
): readonly WineKGEdge[] {
  const edges: WineKGEdge[] = [];
  const seen = new Set<string>();

  const push = (from: string, to: string, type: WineKGEdge['type']): void => {
    if (from === to) return;
    if (!nodes.has(from) || !nodes.has(to)) {
      bootstrapLogger.warn(
        { from, to, type },
        '[wine-kg-loader] dropping orphan edge (endpoint not in node set)',
      );
      return;
    }
    const key = `${from}\u0000${to}\u0000${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, type });
  };

  // 1) Entity-level hierarchy edges (part_of for geographic types, is_a otherwise).
  if (snap.entities !== undefined) {
    for (const [id, ent] of Object.entries(snap.entities)) {
      if (!nodes.has(id)) continue;
      const parents =
        ent.hierarchy !== undefined && ent.hierarchy.length > 0
          ? ent.hierarchy
          : ent.parent !== undefined && ent.parent !== null
            ? [ent.parent]
            : [];
      // Emit only the IMMEDIATE parent as an edge; deeper ancestors are
      // reachable via transitive traversal in KGOperations.ancestors().
      const immediateParentLabel = parents[0];
      if (immediateParentLabel === undefined) continue;
      const parentId = labelIndex.get(immediateParentLabel.toLowerCase());
      if (parentId === undefined) {
        bootstrapLogger.warn(
          { id, parent: immediateParentLabel },
          '[wine-kg-loader] parent label does not resolve to a node',
        );
        continue;
      }
      push(id, parentId, 'part_of');
    }
  } else if (snap.nodes !== undefined) {
    for (const ent of snap.nodes) {
      if (!nodes.has(ent.id)) continue;
      const immediate = ent.parents?.[0];
      if (immediate === undefined) continue;
      const parentId = labelIndex.get(immediate.toLowerCase());
      if (parentId === undefined) {
        bootstrapLogger.warn(
          { id: ent.id, parent: immediate },
          '[wine-kg-loader] parent label does not resolve to a node',
        );
        continue;
      }
      push(ent.id, parentId, 'part_of');
    }
  }

  // 2) Cross-check regionHierarchy label map. This is a secondary source —
  //    it sometimes contains labels that did not survive entity promotion
  //    (e.g. sub-appellations); those are dropped by the orphan guard.
  if (snap.regionHierarchy !== undefined) {
    for (const [childLabel, parentLabel] of Object.entries(snap.regionHierarchy)) {
      const childId = labelIndex.get(childLabel.toLowerCase());
      const parentId = labelIndex.get(parentLabel.toLowerCase());
      if (childId === undefined || parentId === undefined) {
        bootstrapLogger.warn(
          { childLabel, parentLabel },
          '[wine-kg-loader] regionHierarchy label does not resolve to a node',
        );
        continue;
      }
      push(childId, parentId, 'part_of');
    }
  }

  return edges;
}

/**
 * DFS over `is_a` / `part_of` edges to detect cycles. We only check the
 * two hierarchy edge types — domain traversal treats them as DAG-only —
 * other edge types (produces, pairs_with, ...) are allowed to be cyclic.
 */
function assertAcyclic(
  nodes: ReadonlyMap<string, WineKGNode>,
  edges: readonly WineKGEdge[],
): void {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'is_a' && edge.type !== 'part_of') continue;
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes.keys()) color.set(id, WHITE);

  // Iterative DFS with an explicit stack to avoid recursion blowups on
  // deep hierarchies (country → region → sub_region → appellation → ...).
  for (const start of nodes.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack: { id: string; path: string[]; idx: number }[] = [
      { id: start, path: [start], idx: 0 },
    ];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adj.get(frame.id) ?? [];
      if (frame.idx >= children.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const next = children[frame.idx++]!;
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        const cycleStart = frame.path.indexOf(next);
        const cycle =
          cycleStart >= 0
            ? [...frame.path.slice(cycleStart), next]
            : [...frame.path, next];
        throw new Error(
          `[wine-kg-loader] cycle detected in is_a/part_of graph: ${cycle.join(' -> ')}`,
        );
      }
      if (nextColor === BLACK) continue;
      color.set(next, GRAY);
      stack.push({ id: next, path: [...frame.path, next], idx: 0 });
    }
  }
}
