import { afterEach, describe, expect, it } from 'vitest';
import { buildQueryPlanner } from '../../src/config/container-core-builders.js';
import { PlannerV1Adapter } from '../../src/config/planner-v1-adapter.js';
import { SearchUseCase } from '../../src/application/search/search.usecase.js';
import { InterpretUseCase } from '../../src/application/search/interpret.usecase.js';
import { QuerySanitizer } from '../../src/domain/security/service/query-sanitizer.js';
import type { ChatCompletionRequest, ChatCompletionResult, ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { CoreAdapterServices } from '../../src/config/container-adapters.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../src/domain/attribute/model/nl-mapping.js';
import { createEntityId, type EntityId } from '../../src/domain/shared/types/index.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { AnchorEntityData } from '../../src/domain/mixed/service/anchor-profiler.js';
import type { SimilarityCandidate } from '../../src/domain/mixed/service/similarity-scorer.js';
import { createTestContainer } from '../integration/helpers/test-container.js';

class ScriptedChatLlm implements ChatLlmPort {
  public readonly calls: ChatCompletionRequest[] = [];

  constructor(private responseText: string) {}

  setResponseText(responseText: string): void {
    this.responseText = responseText;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls.push(request);
    return {
      text: this.responseText,
      model: 'scripted-ambiguity-llm',
      finishReason: 'stop',
    };
  }
}

class NoopMappingTable implements MappingTablePort {
  async findMapping(_phrase: string): Promise<NLMapping | null> {
    return null;
  }

  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }

  async getCurrentVersion(): Promise<string> {
    return 'test-v1';
  }
}

interface PinotHarness {
  readonly interpretUseCase: InterpretUseCase;
  readonly searchUseCase: SearchUseCase;
  readonly llm: ScriptedChatLlm;
}

const QUERY = '피노';

function makeBranchResponse(branchLabel: string): string {
  return JSON.stringify({
    selections: [
      {
        surface: '피노',
        entityType: 'grape_primary',
        decision: 'select_branches',
        selectedBranchLabels: [branchLabel],
        resolvedQueryClass: 'ambiguous_short_form',
        clarifyQuestion: `피노는 ${branchLabel} 쪽으로 찾을까요?`,
        confidence: 0.98,
      },
    ],
  });
}

function createPinotDoc(
  entityId: EntityId,
  canonicalLabel: string,
  grapePrimary: 'Pinot Noir' | 'Pinot Gris',
  style: string,
  wineType: 'red' | 'white',
  popularityScore: number,
): RetrievalDocument {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel,
    aliasesIdentitySafe: ['피노'],
    aliasesNoisyRecall: [],
    producer: 'Test Pinot House',
    region: grapePrimary === 'Pinot Noir' ? 'Burgundy' : 'Alsace',
    grapes: [grapePrimary],
    searchTextKo: grapePrimary === 'Pinot Noir'
      ? '피노 누아르 테스트 와인'
      : '피노 그리지오 테스트 와인',
    searchTextEn: canonicalLabel,
    semanticSummary: canonicalLabel,
    style,
    priceBand: 'mid',
    availability: true,
    popularityScore,
    grapePrimary,
    wineType,
    grapeFamily: 'pinot_family',
    body: grapePrimary === 'Pinot Noir' ? 0.62 : 0.48,
    sweetness: grapePrimary === 'Pinot Noir' ? 0.12 : 0.18,
    acidity: grapePrimary === 'Pinot Noir' ? 0.58 : 0.72,
    tannin: grapePrimary === 'Pinot Noir' ? 0.54 : 0.18,
    flavorProfiles: grapePrimary === 'Pinot Noir' ? ['cherry', 'earth'] : ['pear', 'citrus'],
    classification: 'test',
    alcoholPct: 12.5,
    regionHierarchy: [grapePrimary === 'Pinot Noir' ? 'France' : 'France'],
    priceBandNumeric: 2,
    producerPrestige: 0.72,
    criticScoreNormalized: 0.88,
    pairing: grapePrimary === 'Pinot Noir' ? ['duck'] : ['shellfish'],
    occasion: grapePrimary === 'Pinot Noir' ? ['dinner'] : ['casual'],
    country: 'France',
    appellation: grapePrimary === 'Pinot Noir' ? 'Bourgogne' : 'Alsace',
  };
}

function seedPinotDocs(parts: ReturnType<typeof createTestContainer>): {
  readonly noirId: EntityId;
  readonly grisId: EntityId;
  readonly noirLabel: string;
  readonly grisLabel: string;
} {
  resetInMemoryState(parts);

  const noirId = createEntityId('pinot-noir-demo');
  const grisId = createEntityId('pinot-gris-demo');
  const noirLabel = 'Pinot Noir Test Cuvée';
  const grisLabel = 'Pinot Gris Test Cuvée';

  const noirDoc = createPinotDoc(noirId, noirLabel, 'Pinot Noir', 'light red', 'red', 0.99);
  const grisDoc = createPinotDoc(grisId, grisLabel, 'Pinot Gris', 'crisp white', 'white', 0.99);

  parts.searchIndex.upsertDoc(noirDoc);
  parts.searchIndex.upsertDoc(grisDoc);

  parts.aliasMatcher.addAlias('피노', noirId, 0.96);
  parts.aliasMatcher.addAlias('피노', grisId, 0.96);

  parts.anchorResolver.addEntity(noirId, buildAnchorEntityData(noirDoc));
  parts.anchorResolver.addEntity(grisId, buildAnchorEntityData(grisDoc));

  parts.candidateAttributes.setAttribute(noirId, buildCandidateAttributes(noirDoc));
  parts.candidateAttributes.setAttribute(grisId, buildCandidateAttributes(grisDoc));
  parts.candidateAttributes.setSimilarity(noirId, buildSimilarityCandidate(noirDoc));
  parts.candidateAttributes.setSimilarity(grisId, buildSimilarityCandidate(grisDoc));

  parts.ambiguityDict.setAmbiguous('피노', ['entity'], 'high');

  return { noirId, grisId, noirLabel, grisLabel };
}

function resetInMemoryState(parts: ReturnType<typeof createTestContainer>): void {
  (parts.searchIndex as unknown as { readonly docs: Map<EntityId, RetrievalDocument> }).docs.clear();
  (parts.aliasMatcher as unknown as {
    readonly aliases: Map<string, Array<{ entityId: EntityId; surfaceForm: string; confidence: number }>>;
    readonly documents: Map<EntityId, RetrievalDocument>;
  }).aliases.clear();
  (parts.aliasMatcher as unknown as {
    readonly aliases: Map<string, Array<{ entityId: EntityId; surfaceForm: string; confidence: number }>>;
    readonly documents: Map<EntityId, RetrievalDocument>;
  }).documents.clear();
  (parts.anchorResolver as unknown as { readonly entities: Map<EntityId, AnchorEntityData> }).entities.clear();
  (parts.candidateAttributes as unknown as {
    readonly attributes: Map<EntityId, Readonly<Record<string, unknown>>>;
    readonly similarities: Map<EntityId, SimilarityCandidate>;
  }).attributes.clear();
  (parts.candidateAttributes as unknown as {
    readonly attributes: Map<EntityId, Readonly<Record<string, unknown>>>;
    readonly similarities: Map<EntityId, SimilarityCandidate>;
  }).similarities.clear();
  (parts.blockingAdapter as unknown as { readonly entityIds: Set<EntityId> }).entityIds.clear();
  (parts.similarRetrieval as unknown as { readonly results: Map<string, readonly unknown[]> }).results.clear();
}

function buildAnchorEntityData(doc: RetrievalDocument): AnchorEntityData {
  return {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body ?? 0,
    sweetness: doc.sweetness ?? 0,
    style: doc.style,
  };
}

function buildCandidateAttributes(doc: RetrievalDocument): Readonly<Record<string, unknown>> {
  return {
    entity_id: doc.entityId,
    canonical_label: doc.canonicalLabel,
    producer: doc.producer,
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    price_band: doc.priceBand,
    availability: doc.availability,
    search_text_en: doc.searchTextEn,
    search_text_ko: doc.searchTextKo,
    wine_type: doc.wineType,
    grape_primary: doc.grapePrimary,
    grape_family: doc.grapeFamily,
    country: doc.country,
    appellation: doc.appellation,
    popularity_score: doc.popularityScore,
  };
}

function buildSimilarityCandidate(doc: RetrievalDocument): SimilarityCandidate {
  return {
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
  };
}

async function buildHarness(branchLabel: 'Pinot Noir' | 'Pinot Gris'): Promise<PinotHarness> {
  const parts = createTestContainer();
  seedPinotDocs(parts);

  const llm = new ScriptedChatLlm(makeBranchResponse(branchLabel));
  const planner = new PlannerV1Adapter(
    await buildQueryPlanner(
      {
        ambiguityDict: parts.ambiguityDict,
        aliasMatcher: parts.aliasMatcher,
        mappingTable: new NoopMappingTable(),
      } as unknown as CoreAdapterServices,
      undefined,
      llm,
    ),
  );

  const interpretUseCase = new InterpretUseCase({
    queryPlanner: planner,
    querySanitizer: new QuerySanitizer(),
  });

  const searchUseCase = new SearchUseCase({
    queryPlanner: planner,
    entityResolver: parts.container.entityResolver,
    entityLookup: parts.searchIndex,
    candidatePool: parts.container.candidatePool,
    browseRetriever: parts.browseRetriever,
    compareRetriever: parts.compareRetriever,
    ranker: parts.container.ranker,
    decisionEngine: parts.container.decisionEngine,
    responseBuilder: parts.container.responseBuilder,
    mixedSolver: parts.container.mixedSolver,
    querySanitizer: new QuerySanitizer(),
    snapshotVersions: parts.container.snapshotVersions,
  });

  return { interpretUseCase, searchUseCase, llm };
}

afterEach(() => {
  delete process.env.CONSTRAINT_GRAPH_TOPOLOGY_LLM;
});

describe('Ambiguity intent compiler e2e', () => {
  it.each([
    ['Pinot Noir', 'Pinot Noir'],
    ['Pinot Gris', 'Pinot Gris Test Cuvée'],
  ] as const)('selecting %s branch narrows clarification and retrieval to %s', async (branchLabel, expectedTopLabel) => {
    const harness = await buildHarness(branchLabel);

    const interpret = await harness.interpretUseCase.execute(
      { query: QUERY, buildV2: true },
    );

    expect(interpret.v1Plan.queryClass).toBe('ambiguous_short_form');
    expect(interpret.v1Plan.expansions.ambiguousEntityHints).toBeDefined();
    expect(interpret.v1Plan.expansions.ambiguityIntentInterpretation).toBeDefined();
    expect(interpret.v1Plan.expansions.ambiguityIntentInterpretation?.branchSelections).toEqual([
      expect.objectContaining({
        surface: '피노',
        decision: 'select_branches',
        selectedBranchLabels: [branchLabel],
      }),
    ]);

    const entityResponse = await harness.searchUseCase.execute(
      {
        query: QUERY,
        options: { mode: 'entity', explain: false, clarification: true },
      },
      `ambiguity-e2e-entity-${branchLabel}`,
    );

    expect(
      entityResponse.engineDecision.decisionStatus === 'ambiguous'
      || entityResponse.clarification !== null,
    ).toBe(true);
    if (entityResponse.clarification !== null) {
      expect(entityResponse.clarification.structuredPayload).toBeDefined();
    }

    const hybridResponse = await harness.searchUseCase.execute(
      {
        query: QUERY,
        options: { mode: 'hybrid', explain: false, clarification: false },
      },
      `ambiguity-e2e-hybrid-${branchLabel}`,
    );

    expect(hybridResponse.results.length).toBeGreaterThan(0);
    expect(hybridResponse.results[0]?.entity.canonicalLabel).toContain(expectedTopLabel);
  });
});
