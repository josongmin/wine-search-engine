# Epic 11 — Wine Knowledge Graph + Entity Resolution

**Phase:** B (학습 점화)
**우선순위:** P1
**의존:** Epic-13 (query slice coverage evaluation), Epic-01 (SSoT)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 현재 상태의 솔직한 진단

### Entity Resolver: 3-tier이지만 ~300 entries

코드 감사 결과 exact-match only는 아님. 3 tier 존재:
1. Exact match (RESOLVER_INDEX, ~300 entries)
2. Compact match (whitespace-stripped)
3. Fuzzy fallback (FuzzyMatcher, edit distance ≤ 2, combinedScore ≥ 0.7)

하지만 **~300 entries는 와인 세계 대비 극히 적다.** Wine-Searcher는 100,000+ producer, 10,000+ appellation을 인덱스한다.

### Compositional Inference: 12 rules

`compositional-inference.ts`에 **정확히 12개 region rule:**
Bordeaux, Burgundy(red/white), Napa, Barolo, Brunello, Champagne, Rioja, Mosel, Marlborough, Mendoza, Barossa.

Priorat, Ribera del Duero, Côtes du Rhône, Willamette Valley, Wachau, Alsace, Loire, Douro, Santorini, Stellenbosch... 모두 커버되지 않음.

**grape→style inference 없음:** "Nebbiolo" 입력 시 high tannin/high acidity 추론 불가. Rules는 region 기반으로만 발동.

### Confidence 미보정

`CONFIDENCE_WINE_TYPE = 0.88`, `CONFIDENCE_COUNTRY = 0.90`, `CONFIDENCE_REGION = 0.90`, `CONFIDENCE_GRAPE = 0.95` — 전부 하드코딩.

---

## 핵심 통찰: Knowledge Graph가 ML보다 먼저

**Neural entity linking (BLINK, GENRE)을 Phase C로 미루는 이유:**
- Training data 없음 (Phase A에서 수집 시작)
- KG는 zero training data로 구축 가능 (catalog에서 자동 추출)
- KG가 있으면 entity resolution + compositional inference 동시 해결
- KG 구축 비용 < ML 모델 학습 비용

---

## Task 목록

### T11-1. Wine Knowledge Graph 구축

**목표:** 정적 hand-curated graph가 아니라 **catalog-derived graph**를 구축한다.

**최소 목표:**
- node 2000+
- resolver vocabulary 5000+
- region/appellation/grape/style 뿐 아니라 **producer alias space**도 포함
- 정적 JSON snapshot은 허용하되 **재생성 가능한 ETL 산출물**이어야 함

**Schema:**
```
Node types: Region, SubRegion, Appellation, Grape, WineType, StyleProfile, ProducerAlias
Edge types:
  - CONTAINS (Region→SubRegion, SubRegion→Appellation)
  - PRODUCES (Appellation→Grape, with weight=dominance)
  - TYPICAL_PROFILE (Appellation→StyleProfile)
  - IS_A (Grape→GrapeFamily: e.g., Pinot Noir→Pinot)
  - ALIAS_OF (Alias/Korean form → canonical entity)
```

**데이터 소스:**
1. 현재 Vespa index의 wine catalog: region/grape/appellation 통계 (가장 정확)
2. `entity-ontology.json` 기존 데이터 확장
3. WINE_TYPE_PATTERNS, REGION_PARENTS 기존 매핑 흡수

**구현:**
- `scripts/etl/build-wine-kg.ts` (catalog → KG 자동 구축)
- `data/wine-knowledge-graph.json`은 snapshot artifact
- `src/domain/shared/model/wine-knowledge-graph.ts`는 query API와 schema 제공

---

### T11-2. Graph-Based Compositional Inference

**현재:** 12 hardcoded rules in `compositional-inference.ts`

**변경:** KG traversal로 교체
```typescript
// "Pauillac" query:
// Pauillac →[CONTAINS]→ Médoc →[CONTAINS]→ Bordeaux (Left Bank)
// Pauillac →[PRODUCES]→ Cabernet Sauvignon (dominant), Merlot
// Bordeaux Left Bank →[TYPICAL_PROFILE]→ { body: high, tannin: high }
```

**장점:**
- 12 rules → 2000+ node graph 기반 자동 커버
- Multi-hop reasoning (Pauillac → Médoc → Bordeaux)
- Grape→style inference 가능 ("Nebbiolo" → high tannin, high acidity)
- Per-edge confidence (dominant grape vs minor grape)

---

### T11-3. FuzzyMatcher → Entity Resolver 통합 강화

**현재:** FuzzyMatcher 이미 코드에 있고 3rd tier로 사용 중

**변경:**
- KG node를 FuzzyMatcher의 vocabulary에 포함 (300 → 5000+ entries)
- KG-guided disambiguation: "Pinot" + context에서 Pinot Noir vs Grigio 구분
- `provenance: 'kg_fuzzy'` 추가

---

### T11-4. Entity Confidence Calibration

**현재:** 0.88-0.95 하드코딩

**변경:**
- 초기값은 graph distance / alias provenance / edit distance로 정의
- 최종 confidence는 `Epic-17`의 gold split 위에서 calibration
- hard-coded confidence는 transition fallback으로만 유지

---

### T11-5. OOV Entity → KG Fallback + Degradation

**현재:** long-tail phrase가 resolver vocabulary 밖이면 누락 가능성 큼

**변경:**
- OOV span → KG에서 가장 가까운 node 탐색 (approximate match)
- 없으면 `degradation_reasons: ['entity_not_in_kg']` + `unmapped_phrase_rate` metric
- LLM fallback (Epic-15에서): OOV → LLM에게 "이 와인 용어가 무엇인지" 질의 (cached)

---

### T11-6. Korean-English Cross-Lingual Entity

**현재:** 한국어 alias가 entity-alias-registry에 수동 등록

**변경:**
- KG에 Korean alias를 edge로 포함
- Transliteration rule 기반 자동 alias 생성 (query-normalizer의 Korean transliteration 재활용)
- 예: "샤또 마고" → Château Margaux (KG node)

---

## 완료 조건

- KG node 수 >= 2000
- resolver vocabulary >= 5000
- graph artifact가 ETL로 재생성 가능
- Compositional inference: 12 rules → KG traversal
- Grape→style inference 동작 ("Nebbiolo" → high tannin)
- OOV rate < 10% on eval query set
