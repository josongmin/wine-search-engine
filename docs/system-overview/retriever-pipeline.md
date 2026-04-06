# 리트리버 파이프라인 (Retriever pipeline)

> **Audience:** 시스템·아키텍처 **리뷰** 전용. 스코프는 `README.md` 참고.

플래너·보안 이후 **`effectiveRoute === 'hybrid'`** 일 때 후보를 만드는 경로를 코드 기준으로 정리한다. 핵심은 (1) **모드별 전문 리트리버**(`browse` / `compare`) 우선, (2) 실패 시 **`CandidatePoolPort.generate`** 로 가는 **하이브리드 풀**(sparse+dense+fusion, RFC-012에 맞춘 도메인 서비스).

**Last updated:** 2026-04-06

---

## 1. 한 줄 요약

- **진입:** `SearchUseCase`의 `executeHybridRoute` 또는 `HybridUseCase`가 `executeHybridRouteRankingPipeline`을 호출한다.
- **후보 생성:** `retrieveHybridCandidatesForPlan`이 `plan.retrievalMode`에 따라 `browseRetriever` / `compareRetriever`를 쓰거나, 기본적으로 `candidatePool.generate(buildHybridRetrievalInputForPlan(...))`로 **Vespa 스파스·임베딩 덴스·RRF 퓨전** 파이프라인을 탄다.
- **후보 이후:** 동일 파일 흐름에서 `runHybridRankingPipeline`이 `ranker.rank` → 선택적 LTR → `buildHybridRouteResolveResult`로 합성 리졸브 결과를 만든다 (리트리버 이후 랭킹 단계).

---

## 2. 라우트 스위치 → 하이브리드 실행

`effectiveRoute`가 `hybrid`이면 `dispatchSearchRouteExecution`이 `executeHybrid`만 호출한다.

```23:40:src/application/search/search-usecase-route-dispatch.ts
export async function dispatchSearchRouteExecution(
  effectiveRoute: QueryRoute,
  actions: {
    readonly executeEntity: () => Promise<EntityResolveResult>;
    readonly executeHybrid: () => Promise<SearchRouteExecutionResult>;
    readonly executeMixed: () => Promise<SearchRouteExecutionResult>;
  },
): Promise<SearchRouteExecutionResult> {
  switch (effectiveRoute) {
    case 'entity': {
      const resolveResult = await actions.executeEntity();
      return { resolveResult, rankedResults: [] };
    }
    case 'hybrid':
      return actions.executeHybrid();
    case 'mixed':
      return actions.executeMixed();
  }
}
```

메인 검색의 하이브리드 경로는 후보를 가져온 뒤 랭킹 파이프라인으로 넘긴다.

```196:210:src/application/search/search.usecase.ts
  private async executeHybridRoute(
    plan: QueryPlanV1,
  ): Promise<{ resolveResult: EntityResolveResult; rankedResults: readonly RankedResult[] }> {
    const candidates = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
      },
      (p) => this.executeEntityRoute(p),
    );

    return runHybridRankingPipeline(plan, candidates, this.deps.ranker, this.deps.ltrModels);
  }
```

`HybridUseCase`는 pre-route 이후 동일한 `executeHybridRouteRankingPipeline` 경로를 쓴다.

```102:116:src/application/search/hybrid.usecase.ts
    const { plan } = preRoute;
    const { resolveResult, rankedResults, decisionContext } = await executeHybridRouteRankingPipeline(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
        ranker: this.deps.ranker,
        ltrModels: this.deps.ltrModels,
      },
      (resolverPlan) => resolveEntityRouteForPlan(resolverPlan, {
        entityResolver: this.deps.entityResolver,
        entityLookup: this.deps.entityLookup,
      }),
    );
```

---

## 3. 포트 (도메인 경계)

리트리버 관련 주입 포트는 `CandidatePoolPort` · `BrowseRetrieverPort` · `CompareRetrieverPort` 이다.

```29:57:src/application/search/port/search-pipeline-deps.port.ts
export interface CandidatePoolPort {
  generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]>;
}

export interface BrowseRetrieverPort {
  browseProducer(
    producerName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;

  browseRegion(
    regionName: string,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}

export interface CompareRetrieverPort {
  compareAgainstAnchor(
    anchorEntityId: EntityId,
    constraints: ConstraintBundle,
    limit: number,
  ): Promise<readonly HybridCandidate[]>;
}
```

---

## 4. `retrieveHybridCandidatesForPlan` — 전문 경로 우선, 풀 폴백

`plan.retrievalMode`가 `producer_browse` / `region_browse` / `compare_candidates` 이면 각각 브라우즈·컴페어 리트리버를 시도하고, 비어 있거나 해당 모드가 아니면 **`CandidatePoolPort.generate`** 로 폴백한다. `compare_candidates`는 앵커 엔티티가 필요해 `resolveEntity(plan)`을 먼저 호출한다.

```74:138:src/application/search/search-usecase-hybrid-candidates.ts
/**
 * Specialized browse/compare paths first; falls back to {@link CandidatePoolPort.generate}.
 */
export async function retrieveHybridCandidatesForPlan(
  plan: QueryPlanV1,
  ports: HybridCandidateRetrievalPorts,
  resolveEntity: (p: QueryPlanV1) => Promise<EntityResolveResult>,
): Promise<readonly HybridCandidate[]> {
  const limit = SPECIALIZED_HYBRID_RETRIEVAL_LIMIT;

  switch (plan.retrievalMode) {
    case 'producer_browse': {
      const producerName = extractProducerBrowseSeed(plan);
      if (producerName !== undefined && ports.browseRetriever !== undefined) {
        const candidates = await ports.browseRetriever.browseProducer(
          producerName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          return candidates;
        }
      }
      break;
    }
    case 'region_browse': {
      const regionName = extractRegionBrowseSeed(plan);
      if (regionName !== undefined && ports.browseRetriever !== undefined) {
        const candidates = await ports.browseRetriever.browseRegion(
          regionName,
          plan.constraints,
          limit,
        );
        if (candidates.length > 0) {
          return candidates;
        }
      }
      break;
    }
    case 'compare_candidates': {
      if (ports.compareRetriever !== undefined) {
        const anchorResolution = await resolveEntity(plan);
        const anchorEntityId = anchorResolution.topEntity?.entityId
          ?? plan.anchors[0]?.candidateEntityIds[0];
        if (anchorEntityId !== undefined) {
          const candidates = await ports.compareRetriever.compareAgainstAnchor(
            anchorEntityId,
            plan.constraints,
            limit,
          );
          if (candidates.length > 0) {
            return candidates;
          }
        }
      }
      break;
    }
    default:
      break;
  }

  const retrievalInput = buildHybridRetrievalInputForPlan(plan, 'hybrid');

  return ports.candidatePool.generate(retrievalInput);
}
```

`buildHybridRetrievalInputForPlan`은 정규화/원문 쿼리와 제약을 `HybridRetrievalInput`으로 묶는다 (`60:71:src/application/search/search-usecase-hybrid-candidates.ts`).

---

## 5. 공유 랭킹 래퍼 (후보 → 랭커)

배치·메인·하이브리드 유스케이스가 같은 “후보 + 랭크” 조합을 쓰도록 `executeHybridRouteRankingPipeline`이 `retrieveHybridCandidatesForPlan`과 `runHybridRankingPipeline`을 연결한다.

```128:144:src/application/search/search-usecase-hybrid-ranking-pipeline.ts
export async function executeHybridRouteRankingPipeline(
  plan: QueryPlanV1,
  deps: HybridRankingRouteDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,
): Promise<SearchRouteExecutionResult> {
  const candidates = await retrieveHybridCandidatesForPlan(
    plan,
    {
      candidatePool: deps.candidatePool,
      browseRetriever: deps.browseRetriever,
      compareRetriever: deps.compareRetriever,
    },
    resolveEntity,
  );

  return runHybridRankingPipeline(plan, candidates, deps.ranker, deps.ltrModels);
}
```

```96:121:src/application/search/search-usecase-hybrid-ranking-pipeline.ts
export async function runHybridRankingPipeline(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  ranker: RankingPort,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): Promise<SearchRouteExecutionResult> {
  const rankingInput: RankingInput = {
    queryPlan: plan,
    candidates,
    constraints: plan.constraints,
  };

  let rankedResults = await ranker.rank(rankingInput);

  rankedResults = applyLtrRerankIfAvailable(
    rankedResults,
    plan.queryClass,
    ltrModels,
  );

  const resolveResult: EntityResolveResult = buildHybridRouteResolveResult(plan, rankedResults);

  return { resolveResult, rankedResults };
}
```

---

## 6. `CandidatePoolService.generate` — 하이브리드 풀 (기본 리트리버)

`CandidatePoolPort`의 구현체는 `CandidatePoolService` (`src/domain/retrieval/service/candidate-pool.ts`). 난이도에 따라 `CascadeRouter`가 단계(`sparse` / `dense` / `anchor_neighborhood` / `rerank`)를 고르고, sparse·dense·앵커 이웃 검색 후 **RRF 퓨전**, 제약 주석·하드 필터, top-K 반환.

```15:43:src/domain/retrieval/service/candidate-pool.ts
/**
 * Orchestrates the full hybrid retrieval pipeline (RFC-012).
 *
 * Pipeline steps:
 * 1. Execute sparse search with lexical queries + hard constraint filters.
 * 2. Embed semantic queries and execute dense search (with embedding cache).
 * 3. If an anchor profile is present, embed anchor and run neighbourhood search.
 * 4. Fuse all passes via RRF.
 * 5. Apply hard constraint filter on fused candidates.
 * 6. Return top-K candidates.
 *
 * Dependencies injected for testability and loose coupling (SOLID - D principle).
 */
export class CandidatePoolService {
  private readonly profileService: RetrievalProfileService;
  private readonly cascadeRouter: CascadeRouter;
  private readonly constraintFilter: ConstraintFilter;

  constructor(
    private readonly searchIndex: SearchIndexPort,
    private readonly embeddingService: EmbeddingServicePort,
    private readonly fusionService: FusionService,
    private readonly cacheService?: CacheService | undefined,
    private readonly embeddingModelId: string = 'bge-m3',
  ) {
    this.profileService = new RetrievalProfileService();
    this.cascadeRouter = new CascadeRouter();
    this.constraintFilter = new ConstraintFilter();
  }
```

```51:83:src/domain/retrieval/service/candidate-pool.ts
  async generate(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]> {
    const profile = this.profileService.getProfile(
      input.queryPlan.queryClass,
      input.route,
    );

    const anchorConfidence = input.anchorProfile?.anchorConfidence ?? 0;
    const aliasMatchStrength = this.estimateAliasStrength(input);

    const difficulty = this.cascadeRouter.estimateDifficulty(
      input.queryPlan.queryClass,
      anchorConfidence,
      aliasMatchStrength,
      input.hardConstraints.length + input.softConstraints.length,
    );

    const phases = this.cascadeRouter.getPhases(difficulty);
    const phaseSet = new Set<RetrievalPhase>(phases);

    const allPhases: RetrievalPhase[] = ['sparse', 'dense', 'anchor_neighborhood', 'rerank'];
    const skippedPhases = allPhases.filter((p) => !phaseSet.has(p));

    // Vespa sparse filter tokens (aligned with browse/compare + buildSparseFilters)
    const filters = [...hardConstraintsToSparseFilterTokens(input.hardConstraints)];

    // Step 1: Sparse search
    const sparseHits = phaseSet.has('sparse')
      ? await this.searchIndex.sparseSearch(
          input.lexicalQueries,
          filters.length > 0 ? filters : undefined,
          profile.sparseTopN,
        )
      : [];
```

```129:162:src/domain/retrieval/service/candidate-pool.ts
    // Step 4: Fuse via RRF
    let candidates = this.fusionService.fuse(
      sparseHits,
      denseHits,
      anchorHits,
      profile.fusionK,
    );

    // Enrich traces with pipeline context
    candidates = candidates.map((c) => ({
      ...c,
      retrievalTrace: {
        ...c.retrievalTrace,
        retrievalProfile: profile.name,
        lexicalQueriesUsed: [...input.lexicalQueries],
        semanticQueriesUsed: [...input.semanticQueries],
        filtersApplied: filters,
        skippedPhases,
      } satisfies RetrievalTrace,
    }));

    candidates = annotateCandidateConstraintEvidenceBatch(candidates, {
      hard: input.hardConstraints,
      soft: input.softConstraints,
      inferred: input.queryPlan.constraints.inferred,
    });

    // Step 5: Apply hard constraint filter
    candidates = [
      ...this.constraintFilter.applyHardFilters(candidates, input.hardConstraints),
    ];

    // Step 6: Return top-K
    return candidates.slice(0, profile.finalTopK);
  }
```

---

## 7. DI (구성 루트)

`container-core-builders.ts`에서 풀·브라우즈·컴페어 리트리버가 `SearchIndexPort` 등과 함께 조립된다.

**도메인 구현 클래스:** `BrowseRetriever` → `src/domain/retrieval/service/browse-retriever.ts`, `CompareRetriever` → `src/domain/retrieval/service/compare-retriever.ts` (둘 다 `SearchIndexPort` 기반 sparse/제약 경로).

```114:134:src/config/container-core-builders.ts
export function buildCandidatePool(
  adapters: CoreAdapterServices,
  support: RuntimeSupportServices,
  config: Config,
): CandidatePoolService {
  return new CandidatePoolService(
    adapters.searchIndex,
    adapters.embeddingService,
    new FusionService(),
    support.cacheService,
    config.embedding.model,
  );
}

export function buildBrowseRetriever(adapters: CoreAdapterServices): BrowseRetrieverPort {
  return new BrowseRetriever(adapters.searchIndex);
}

export function buildCompareRetriever(adapters: CoreAdapterServices): CompareRetrieverPort {
  return new CompareRetriever(adapters.searchIndex);
}
```

---

## 8. `entity` / `mixed` 와의 구분 (참고)

- **`entity` 라우트:** 스파스·덴스 풀 없이 리졸버만 (`executeEntityRoute`).
- **`mixed` 라우트:** `MixedSolver`·`similarRetrieval` 등 **별도** 혼합 솔버 경로 (`search.usecase.ts`의 `executeMixed` → `mixedSolver.solve`). 이 문서의 “하이브리드 리트리버 파이프라인”과는 다른 모듈이다. 구현은 `src/domain/mixed/` 및 `src/config/container-core-builders.ts`의 `buildMixedSolver` 참고.

---

## 관련 RFC

- **RFC-012** — Hybrid retrieval (sparse + dense + fusion 개념 정합)

인덱스: `docs/RFC-INDEX.md`.
