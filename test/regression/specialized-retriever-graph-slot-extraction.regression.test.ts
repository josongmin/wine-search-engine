/**
 * ADR-014 Phase 1b.3b: browse / compare retrievers derive hard-filter
 * tokens from the constraint graph's hard-tier slots when a graph is
 * present. Trivial-graph emission is byte-identical to the pre-PR5
 * `plan.constraints.hard` → `hardConstraintsToSparseFilterTokens` path.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowseRetriever } from '../../src/domain/retrieval/service/browse-retriever.js';
import { CompareRetriever } from '../../src/domain/retrieval/service/compare-retriever.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/index.js';
import type { SearchIndexPort } from '../../src/domain/retrieval/port/search-index.port.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type {
  ConstraintGraph,
  ConstraintGraphNode,
} from '../../src/domain/query/model/constraint-graph.js';

function slot(id: string, attribute: string, value: string): ConstraintGraphNode {
  return {
    kind: 'slot',
    nodeId: id,
    atomRef: id,
    attribute,
    operator: '=',
    value,
    sourceTier: 'hard',
    sourceKind: 'explicit_utterance',
    confidence: 1,
  };
}

function graph(
  rootId: string,
  nodes: readonly ConstraintGraphNode[],
): ConstraintGraph {
  return {
    graphSchemaVersion: 'constraint_graph_v1',
    origin: 'deterministic_from_atoms',
    rootNodeId: rootId,
    nodes,
    edges: [],
    globalBudgets: {},
  };
}

function stubSearchIndex(): SearchIndexPort {
  return {
    sparseSearch: vi.fn().mockResolvedValue([]),
    denseSearch: vi.fn().mockResolvedValue([]),
    anchorSearch: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    getDocuments: vi.fn().mockResolvedValue(new Map()),
  } as unknown as SearchIndexPort;
}

describe('specialized retrievers — ADR-014 graph-slot filter extraction', () => {
  it('browseProducer: trivial graph → same filters as flat constraints path', async () => {
    const flatBundle: ConstraintBundle = {
      hard: [
        { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };

    const index1 = stubSearchIndex();
    const index2 = stubSearchIndex();
    const retrieverFlat = new BrowseRetriever(index1);
    const retrieverGraph = new BrowseRetriever(index2);

    await retrieverFlat.browseProducer('Opus One', flatBundle, 10);
    await retrieverGraph.browseProducer(
      'Opus One',
      flatBundle,
      10,
      graph('root', [
        { kind: 'group_and', nodeId: 'root', children: ['s1'] },
        slot('s1', 'wine_type', 'red'),
      ]),
    );

    // Both invocations must call sparseSearch with the same filter set
    // (byte-identical tokens).
    const flatCall = (index1.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    const graphCall = (index2.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(flatCall?.[1]).toEqual(graphCall?.[1]);
  });

  it('browseProducer: XOR slot emits union of branch filter tokens', async () => {
    const bundle: ConstraintBundle = { hard: [], soft: [], inferred: [] };
    const g = graph('root', [
      { kind: 'group_xor', nodeId: 'root', children: ['s1', 's2'] },
      slot('s1', 'wine_type', 'red'),
      slot('s2', 'wine_type', 'white'),
    ]);
    const index = stubSearchIndex();
    const retriever = new BrowseRetriever(index);
    await retriever.browseProducer('Any', bundle, 5, g);
    const call = (index.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    // Both branches' attribute value should appear in the flattened
    // filter tokens — Vespa filter tokens are AND-of-ORs by construction,
    // so disjunction surfaces via the per-attribute builder.
    const filters = call?.[1] ?? [];
    const joined = JSON.stringify(filters);
    expect(joined).toContain('red');
    expect(joined).toContain('white');
  });

  it('browseRegion: absent graph → flat `constraints.hard` path unchanged', async () => {
    const flatBundle: ConstraintBundle = {
      hard: [
        { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };
    const index = stubSearchIndex();
    const retriever = new BrowseRetriever(index);
    await retriever.browseRegion('Bordeaux', flatBundle, 5);
    const call = (index.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1]).toBeDefined();
  });

  it('compareAgainstAnchor: trivial-graph filters byte-identical to flat path', async () => {
    const flatBundle: ConstraintBundle = {
      hard: [
        { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };

    const anchorDoc = {
      entityId: 'anchor-001' as CanonicalEntityId,
      canonicalLabel: 'Anchor Wine 2018',
      producer: 'Anchor Producer',
      region: 'Bordeaux',
      grapes: ['Cabernet'] as readonly string[],
      style: 'bold red',
      appellation: undefined,
      country: undefined,
    };

    const index1 = stubSearchIndex();
    const index2 = stubSearchIndex();
    (index1.getDocument as ReturnType<typeof vi.fn>).mockResolvedValue(anchorDoc);
    (index2.getDocument as ReturnType<typeof vi.fn>).mockResolvedValue(anchorDoc);

    const retrieverFlat = new CompareRetriever(index1);
    const retrieverGraph = new CompareRetriever(index2);

    await retrieverFlat.compareAgainstAnchor(
      'anchor-001' as CanonicalEntityId,
      flatBundle,
      10,
    );
    await retrieverGraph.compareAgainstAnchor(
      'anchor-001' as CanonicalEntityId,
      flatBundle,
      10,
      graph('root', [
        { kind: 'group_and', nodeId: 'root', children: ['s1'] },
        slot('s1', 'wine_type', 'red'),
      ]),
    );

    const flatCall = (index1.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    const graphCall = (index2.sparseSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(flatCall?.[1]).toEqual(graphCall?.[1]);
  });
});
