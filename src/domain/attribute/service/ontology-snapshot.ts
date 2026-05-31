import {
  GRAPE_ALIASES,
  REGION_PARENTS,
  WINE_TYPE_ALIASES,
} from '../../shared/wine-ontology-constants.js';
import { CURATED_ENTITY_ALIASES } from './entity-alias-registry.js';
import { wineTitleCase } from '../../shared/utils/title-case.js';

interface OntologySnapshotNode {
  readonly id: string;
  readonly entityType: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
  readonly canonicalLabel: string;
  readonly aliases: readonly string[];
  readonly parents: readonly string[];
}

/** RFC-019 P3 entity entry in the keyed `entities` map. */
interface OntologyEntity {
  readonly id: string;
  readonly type: OntologySnapshotNode['entityType'];
  readonly canonical: string;
  readonly parent: string | null;
  readonly hierarchy: readonly string[];
  readonly aliases: readonly string[];
}

interface OntologySnapshot {
  readonly version: string;
  readonly generatedAt: string;
  readonly nodes: readonly OntologySnapshotNode[];
  /** RFC-019 P3: keyed entity map (e.g. `"region:bordeaux"` → entity). */
  readonly entities: Readonly<Record<string, OntologyEntity>>;
  /** RFC-019 P3: flat child→parent region mapping. */
  readonly regionHierarchy: Readonly<Record<string, string>>;
  /** RFC-019 P3: grape alias→canonical mapping. */
  readonly grapeAliases: Readonly<Record<string, string>>;
  /** RFC-019 P3: wine type alias→canonical mapping. */
  readonly wineTypeAliases: Readonly<Record<string, string>>;
}

export const ONTOLOGY_SNAPSHOT_VERSION = 'ontology-snapshot-v1.0';

export function buildOntologySnapshot(
  generatedAtIso: string = new Date().toISOString(),
): OntologySnapshot {
  const countrySet = new Set<string>();
  for (const parents of REGION_PARENTS.values()) {
    const last = parents[parents.length - 1];
    if (last !== undefined) {
      countrySet.add(last);
    }
  }

  const nodes: OntologySnapshotNode[] = [];

  for (const country of [...countrySet].sort((left, right) => left.localeCompare(right))) {
    nodes.push({
      id: `country:${country}`,
      entityType: 'country',
      canonicalLabel: wineTitleCase(country),
      aliases: [wineTitleCase(country)],
      parents: [],
    });
  }

  for (const [region, parents] of [...REGION_PARENTS.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const entityType = parents.length <= 1 ? 'region' : inferOntologyRegionEntityType(region);
    nodes.push({
      id: `${entityType}:${region}`,
      entityType,
      canonicalLabel: wineTitleCase(region),
      aliases: [wineTitleCase(region)],
      parents: parents.map((parent) => wineTitleCase(parent)),
    });
  }

  for (const [alias, canonical] of collectAliasGroups(GRAPE_ALIASES)) {
    nodes.push({
      // eslint-disable-next-line no-restricted-syntax -- ontology node ID, not a Vespa filter token
      id: `grape_primary:${canonical}`,
      entityType: 'grape_primary',
      canonicalLabel: wineTitleCase(canonical),
      aliases: alias.map((entry) => wineTitleCase(entry)),
      parents: [],
    });
  }

  for (const [alias, canonical] of collectAliasGroups(WINE_TYPE_ALIASES)) {
    nodes.push({
      id: `wine_type:${canonical}`,
      entityType: 'wine_type',
      canonicalLabel: canonical,
      aliases: alias,
      parents: [],
    });
  }

  const dedupedNodes = dedupeNodes(nodes);

  // ── RFC-019 P3: build keyed entities map ──
  const entities: Record<string, OntologyEntity> = {};
  for (const node of dedupedNodes) {
    // Collect curated Korean aliases for this entity
    const curatedAliases: string[] = [];
    for (const alias of CURATED_ENTITY_ALIASES) {
      if (alias.resolutionMode !== 'direct') continue;
      if (alias.canonicalValue.toLowerCase() === node.canonicalLabel.toLowerCase()) {
        curatedAliases.push(alias.surface);
      }
    }

    const allAliases = [...new Set([...node.aliases, ...curatedAliases])]
      .sort((left, right) => left.localeCompare(right));

    const directParent = node.parents.length > 0 ? node.parents[0]! : null;

    entities[node.id] = {
      id: node.id,
      type: node.entityType,
      canonical: node.canonicalLabel,
      parent: directParent,
      hierarchy: node.parents,
      aliases: allAliases,
    };
  }

  // ── RFC-019 P3: flat region hierarchy (child→immediate parent) ──
  const regionHierarchy: Record<string, string> = {};
  for (const [region, parents] of REGION_PARENTS) {
    if (parents.length > 0) {
      regionHierarchy[wineTitleCase(region)] = wineTitleCase(parents[0]!);
    }
  }

  // ── RFC-019 P3: grape aliases ──
  const grapeAliases: Record<string, string> = {};
  for (const [alias, canonical] of GRAPE_ALIASES) {
    grapeAliases[alias] = canonical;
  }

  // ── RFC-019 P3: wine type aliases ──
  const wineTypeAliases: Record<string, string> = {};
  for (const [alias, canonical] of WINE_TYPE_ALIASES) {
    wineTypeAliases[alias] = canonical;
  }

  return {
    version: ONTOLOGY_SNAPSHOT_VERSION,
    generatedAt: generatedAtIso,
    nodes: dedupedNodes,
    entities,
    regionHierarchy,
    grapeAliases,
    wineTypeAliases,
  };
}

function collectAliasGroups(map: ReadonlyMap<string, string>): readonly [readonly string[], string][] {
  const grouped = new Map<string, string[]>();
  for (const [alias, canonical] of map.entries()) {
    const existing = grouped.get(canonical) ?? [];
    existing.push(alias);
    grouped.set(canonical, existing);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([canonical, aliases]) => [[...new Set(aliases)].sort((left, right) => left.localeCompare(right)), canonical] as const);
}

function dedupeNodes(nodes: readonly OntologySnapshotNode[]): readonly OntologySnapshotNode[] {
  const byId = new Map<string, OntologySnapshotNode>();
  for (const node of nodes) {
    const existing = byId.get(node.id);
    if (existing === undefined) {
      byId.set(node.id, node);
      continue;
    }
    byId.set(node.id, {
      ...node,
      aliases: [...new Set([...existing.aliases, ...node.aliases])].sort((left, right) => left.localeCompare(right)),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function inferOntologyRegionEntityType(region: string): OntologySnapshotNode['entityType'] {
  switch (region) {
    case 'barolo':
    case 'barbaresco':
    case 'brunello di montalcino':
    case 'chianti':
    case 'chianti classico':
    case 'pauillac':
    case 'margaux':
    case 'saint-émilion':
      return 'appellation';
    default:
      return 'region';
  }
}

/**
 * Wine-domain-aware title case: lowercase Romance prepositions/articles
 * (di, du, de, del, etc.) except when they start the string.
 */
