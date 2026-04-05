# Epic 1: Bronze → Silver → Gold ETL Pipeline

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 1
**의존성:** 없음 (첫 번째)
**블록하는 Epic:** 2, 3, 4, 5, 6, 7, 8 (거의 전부)

---

## 목표

Vivino 10K Bronze snapshot → Silver 정규화 → Vespa wine_entity 인덱싱 완료.
이 Epic이 안 끝나면 Recall@100 측정 자체가 불가.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts` | ✅ Bronze DB에서 row 추출 |
| `vespa/app/schemas/wine_entity.sd` | ✅ 70+ fields, 4 rank profiles |
| `src/infrastructure/vespa/embedding-service.ts` | ✅ BGE-M3 HTTP adapter |
| `scripts/seed-wines-real.ts` | ✅ 90개 수동 시드 (참고용) |
| Entity types `wine/vintage/producer/region/grape` | ✅ 도메인 모델 존재 |

## 작업 항목

### 1.1 Silver Transformer

**파일:** `scripts/etl/vivino-to-silver.ts`

- Vivino payload JSON → `SilverWineRecord` 타입 변환
- `normalizeLabel()`: display_name에서 생산자 중복 제거, vintage 분리
- `normalizeScale()`: Vivino 1-5 → 0-1 (body/acidity/tannin/sweetness)
- `computePopularity()`: `log1p(ratings_count) / log1p(max_count)`
- `buildSearchText()`: style.description + flavor groups → searchTextEn
- `VIVINO_STYLE_MAP`: wine_type enum 매핑
- price_band 계산 (priceUsd → value/mid/premium/luxury)

**Vivino payload JSONB 추출 필드 전체 목록 (RFC-017 §3.1):**

```
winery.name, winery.id
vintage.year, vintage.seo_name
style.body_description, style.acidity_description, style.description
statistics.ratings_average, statistics.ratings_count, statistics.labels_count
grapes[].name
food_pairings[]
region.name, region.country.name, region.country.code
taste.structure.acidity, taste.structure.fizziness, taste.structure.intensity
taste.structure.sweetness, taste.structure.tannin
taste.flavor[].group, taste.flavor[].stats.count
```

**RFC-002 원칙:** raw display_name → canonical_label 직접 매핑 금지. normalizeLabel() 필수.

### 1.2 Alias Generation

**파일:** `scripts/etl/generate-aliases.ts`

- Typed `ProposedAlias` (RFC-003 준수): value, type, source, confidencePrior, needsReview
- 규칙 기반 4가지: producer identity, producer+vintage, accent fold, short name
- `AliasBundle`: proposed → identitySafeProjection + noisyRecallProjection

### 1.3 Korean Alias (LLM 배치)

**파일:** `scripts/etl/generate-korean-aliases.ts`

- Claude Haiku 배치: 10K × 3 변형 = ~$0.60
- 출력은 `phonetic` / `catalog_noise_alias` ProposedAlias
- cross-entity collision check 통과 전 projection 반영 금지
- high-collision → `needsReview=true`

### 1.4 Deduplication

- `(external_id, vintage_year)` 기준 중복 제거
- 선택 우선순위: 최신 scraped_at → 높은 ratings_count → tasting notes 존재
- `entity_id = hash(source + ":" + external_id)` — Vespa upsert idempotency

### 1.5 Silver Data Quality Gate

**파일:** `scripts/etl/validate-silver.ts`

- 필드별 non-null 비율 측정
- 차단 조건: minRecords ≥ 8000, tastingNotesCoverage ≥ 0.30, aliasMeanCount ≥ 3
- body 분포 sanity check (전부 0이면 변환 버그)
- 결과: `data/silver-quality-report.json`

### 1.6 Document Expansion (doc2query)

**파일:** `scripts/etl/generate-doc-queries.ts`

- LLM으로 문서당 합성 query 5-10개 생성
- searchTextEn에 delimiter 구분으로 append
- sparse recall 극적 개선. 비용 ~$1-3.

### 1.7 Vespa Indexing

**파일:** `scripts/etl/index-to-vespa.ts`

- Silver → RetrievalDocument → embedding → Vespa feed
- **BGE-M3 instruction prefix 필수:**
  - Document: prefix 없음
  - Query (검색 시): `"Represent this sentence for searching relevant passages: "`
- 배치 처리: chunk → embedBatch → upsert

**BGE-M3 Multi-Representation Roadmap:**
- **Phase 1 (이 Epic):** Dense only, 128-dim. 현재 schema `tensor<float>(x[128])`.
- **Phase 2 (Epic 3 eval 후):** Embedding service에서 sparse weights도 반환 → Vespa learned sparse field 추가 → BM25 + learned sparse + dense = 3-signal RRF
- **Phase 3 (Recall 부족 시):** ColBERT multi-vector → Vespa MaxSim operator

**Embedding Dimension:**
- 현재 128-dim = BGE-M3 native 1024에서 87.5% 정보 손실
- 권장: 768 (품질/latency/storage 균형). BGE-M3는 Matryoshka 미지원.
- **결정:** Phase 1에서 128로 먼저 인덱싱. Epic 3 eval에서 128 vs 768 Recall@100 비교 후 dim upgrade 여부 확정.
- dim 변경 시 전체 re-embedding 필�� (10K이므로 허용 범위)

## Deliverables

- [ ] `scripts/etl/vivino-to-silver.ts`
- [ ] `scripts/etl/generate-aliases.ts`
- [ ] `scripts/etl/generate-korean-aliases.ts`
- [ ] `scripts/etl/validate-silver.ts`
- [ ] `scripts/etl/generate-doc-queries.ts`
- [ ] `scripts/etl/index-to-vespa.ts`
- [ ] `data/silver-quality-report.json`
- [ ] 10K wines in Vespa (verified via count query)

## 완료 기준

- [ ] Vespa wine_entity count ≥ 8000 (dedup 후)
- [ ] Silver quality gate 통과
- [ ] tastingNotesCoverage ≥ 0.30
- [ ] alias mean count ≥ 3 per entity
- [ ] popularity_score 분포 확인 (상수 0.3이 아닌 실제 분포)
