# RFC-019 — NL Mapper Elevation to Ontology-Grounded Semantic Constraint Compiler

**상태**: Draft
**작성일**: 2026-04-09
**상위·연관 문서**
- `RFC-004` — Facet / Attribute Normalization SSOT
- `RFC-005` — Query Planner / Policy Compiler
- `RFC-012` — Hybrid Retrieval
- `RFC-018` — Drinking Window Deterministic Kinetics Model
- `RFC-000` — Master Architecture

**충돌 시 RFC-004가 우선한다.**

---

## 0. 한 줄 방향

> **Rule table → ontology-grounded constraint compiler**

이 RFC는 NL Mapper를 단순 phrase lookup 컴포넌트가 아니라,
검색 시스템 전체의 **1급 추론 엔진**으로 승격하는 설계를 정의한다.

목표는 더 이상:

```text
phrase -> attribute=value
```

에 머무는 것이 아니다. 목표는 다음이다.

```text
text -> span -> entity -> ontology -> constraints -> retrieval plan
```

즉, `RFC-019`는 "커버리지 보강" RFC가 아니라
**ontology-driven semantic compiler** RFC로 읽혀야 한다.

---

## 1. Problem Statement

현재 파이프라인은 자연어 쿼리에서 일부 phrase를 잡아 정규화된 constraint로 바꾸지만,
그 수준이 주로 사전 기반 대응에 머무른다.

v15 벤치마크 로그 (`quick-v15-final-full.log`) 기준:

| 지표 | 값 |
|------|-----|
| `constraintExtraction.fallbackTriggered: true` | **23/27 (85.2%)** |
| `ruleTableHitCount > 0` 쿼리 | 4/27 (14.8%) |
| `llmHitCount` (모든 쿼리 합계) | **0** |
| `llmLatencyMs` | null |
| Mean hardConstraint count | 1.15 |

v16 구조 개선 후 관찰된 중간 성과:

| 지표 | 값 |
|------|-----|
| `fallbackTriggered` 비율 | **51.7%** |
| `ruleTableHitCount > 0` 쿼리 | **48.3%** |
| Mean hard constraints | 1.38 |
| Benchmark Ctx Relevance | **72.2%** |

이는 분명 의미 있는 개선이지만, 여전히 시스템의 기본 형태는 다음과 같다.

```text
phrase match -> flat constraint
```

이 구조의 근본 한계는 다음 4가지다.

1. **Entity resolution 부재**: `"보르도"`가 region인지 producer인지 wine style hint인지 문맥적으로 해석되지 않는다.
2. **Ontology 활용 부재**: 이미 보유한 `region_hierarchy`, `grape_hierarchy`, `grape_family`를 retrieval용 필드로만 쓰고, 추론에는 쓰지 않는다.
3. **Compositional inference 부재**: `"레드" + "보르도" + "2018"`를 독립 제약 3개로만 취급하고, 상호작용으로부터 구조적 속성을 유도하지 못한다.
4. **평가 척도 한계**: fallback/hit-rate는 측정하되, "의미적으로 필요한 constraint를 얼마나 회수했는가"는 측정하지 않는다.

즉, 지금의 NL Mapper는 "잘 다듬어진 dictionary lookup system"이고,
본 RFC의 목표는 이를 **semantic reasoning compiler**로 바꾸는 것이다.

---

## 2. 왜 현재 설계만으로는 SOTA가 아닌가

### 2.1 현재 vs 목표

| 현재 | 목표 |
|------|------|
| phrase 매칭 | entity resolution |
| flat attribute | ontology graph |
| 단일 constraint | compositional constraint bundle |
| 정적 매핑 | context-aware deterministic inference |
| filter 중심 | filter + boost + expansion |
| hit-rate KPI | semantic recall KPI |

### 2.2 현재 구조의 본질

현재 RFC-019 초안은 이미 좋은 방향을 갖고 있다.

- `DEFAULT_MAPPINGS` 확장
- 외부 rule table 자동 생성
- LLM fallback의 역할 제한
- 커버리지 계측 강화

그러나 이것만으로는 본질이 바뀌지 않는다.

```text
phrase -> canonical attribute/value
```

이 구조는 coverage는 높일 수 있어도,
아래와 같은 multi-hop inference를 제대로 못 한다.

```text
"샴페인"
  -> entity: Champagne
  -> type: region/appellation
  -> country: France
  -> wine_type: sparkling
  -> production_method: traditional
  -> aging_potential: high
```

따라서 본 RFC는 Tier 2를 "auto-generated bulk mappings"에 머무르게 두지 않고,
**Entity Resolver Layer**로 승격한다.

---

## 3. 설계 원칙

### 3.1 RFC-004 정합 원칙

반드시 유지할 원칙:

- hard constraint는 deterministic provenance가 있어야 한다.
- LLM은 **hard constraint 자체를 생성하지 않는다**.
- 모든 canonicalization은 versioned, replayable, inspectable 해야 한다.
- 범위/비교 연산자는 수치 span에서만 결정적으로 생성한다.

### 3.2 본 RFC의 추가 원칙

- NL Mapper의 출력은 "검색 전처리 부속물"이 아니라 **retrieval plan의 상위 명세**여야 한다.
- ontology expansion은 retrieval recall 확장뿐 아니라 ranking feature, downstream reasoning 입력을 동시에 개선해야 한다.
- ambiguity 해소는 가능하면 deterministic; 불가할 때만 LLM을 linker/disambiguator로 사용한다.
- 한 phrase의 의미는 독립적으로만 보지 않고, query-level composition으로 재해석한다.
- 측정은 hit-count가 아니라 **semantic recall / linking accuracy / expansion precision**으로 관리한다.

---

## 4. 활용 가능한 자산

핵심은 새 데이터를 수집하는 것이 아니라,
이미 존재하는 자산을 **entity/ontology compiler의 입력 자산**으로 재배치하는 것이다.

### 4.1 Vespa 인덱스

**파일**: `vespa/app/schemas/wine_entity.sd`

- `wine_type`
- `country`
- `region`
- `appellation`
- `grape_primary`
- `grapes`
- `grape_family`
- `grape_hierarchy`
- `region_hierarchy`
- `aliases_noisy_recall`
- `aliases_identity_safe`
- `canonical_label`

이 필드들은 단순 retrieval attribute가 아니라,
이미 사실상 ontology의 primitive다.

### 4.2 Silver / ETL 자산

**디렉토리**: `scripts/etl/`

- `vivino-to-silver.ts`
- `validate-silver.ts`
- `generate-aliases.ts`
- `generate-korean-aliases.ts`
- `generate-transliteration-aliases.ts`

특히 `generate-korean-aliases.ts`는
"canonical entity -> multilingual surface form" 생성기의 핵심 자산이다.

### 4.3 Query-side supervision 자산

- `data/golden-queries-silver.jsonl`
- `data/golden-queries-gate.jsonl`
- `data/golden-queries-val.jsonl`
- `test/benchmark/agent/scenarios.ts`
- `test/benchmark/agent/scenarios.coverage.ts`
- `test/benchmark/agent/scenarios.adversarial.ts`

이들은 phrase coverage 평가용을 넘어서,
**semantic constraint recall의 GT 구축**에 사용한다.

### 4.4 RFC-018 downstream contract

`RFC-018`은 deterministic kinetics model이다.
이 모델의 성능은 입력 분포가 structure-aware할수록 좋아진다.

즉:

- `region=Bordeaux`
- `grape_family=Cabernet`
- `tannin>=3`
- `aging_potential=high`

같은 상위 구조가 잘 들어올수록, RFC-018은 더 일관된 drinking window를 산출한다.

따라서 RFC-019는 retrieval만 개선하는 RFC가 아니라,
**RFC-018의 입력 분포를 정상화하는 upstream semantic compiler**이기도 하다.

---

## 5. 목표 아키텍처

### 5.1 End-to-end 파이프라인

```text
Query
  ↓
Span Parser
  ↓
Entity Resolver
  ↓
Ontology Expansion
  ↓
Constraint Builder (hard + soft + inferred)
  ↓
Retrieval Planner (filter + boost + expansion)
  ↓
Wine Candidates
  ↓
Deterministic Aging / Decision Layers (RFC-018 포함)
  ↓
Output
```

### 5.2 현재 파이프라인과의 차이

현재:

```text
query -> n-grams -> phrase lookup -> flat constraints
```

목표:

```text
query -> spans -> resolved entities -> ontology traversal -> composed constraints
```

이 차이가 바로 "좋은 룰 테이블"과 "SOTA급 semantic compiler"의 차이다.

---

## 6. 핵심 설계

### 6.1 Stage 1: Span-based Parsing

현재 `n-gram tokenize(query)`는 다음 문제가 있다.

- 중복 span이 많이 생긴다.
- longest match 우선순위가 약하다.
- span 간 충돌을 문맥적으로 해소하지 못한다.
- `"레드 와인"` 같은 복합 표현이 `"레드"`와 `"와인"`으로 분해된다.

따라서 파싱 단위를 phrase bag가 아니라 **resolved span set**으로 바꾼다.

예:

```text
query: "보르도 2018 레드 와인 추천"

현재:
["보르도", "2018", "레드", "와인", "레드 와인", "추천", ...]

목표:
[
  Span("보르도", type=candidate_entity),
  Span("2018", type=numeric_year),
  Span("레드 와인", type=style_phrase),
]
```

Span parser 요구사항:

- longest-match priority
- overlap resolution
- numeric/date/unit span normalization
- Korean/English 혼합 쿼리 지원
- stopword와 semantic carrier 분리

### 6.2 Stage 2: Entity Resolver Layer

Tier 2는 더 이상 단순 `data/nl-mappings.json` lookup이 아니다.
Tier 2는 **Entity Resolver Layer**다.

입력:

- span text
- span type
- 주변 span context
- query-level prior

출력:

```ts
type ResolvedEntity = {
  entityId: string;
  entityType:
    | 'wine_type'
    | 'country'
    | 'region'
    | 'appellation'
    | 'grape'
    | 'producer'
    | 'wine';
  canonicalLabel: string;
  confidence: number;
  provenance: 'default_mapping' | 'file_mapping' | 'resolver_rule' | 'llm_linker';
  matchedSpan: string;
  aliasesMatched: string[];
};
```

예:

```text
"보르도"
  -> entityId: "region:bordeaux"
  -> entityType: "region"
  -> canonicalLabel: "Bordeaux"
```

이 단계의 핵심은 `"보르도" -> region=Bordeaux`에서 멈추지 않는 것이다.
"보르도"는 constraint가 아니라 먼저 **entity**가 되어야 한다.

### 6.3 Stage 3: Ontology Graph

Resolver가 뱉은 entity는 ontology node다.
이 node에서 graph expansion을 수행한다.

예시 entity:

```ts
type OntologyEntity = {
  id: 'region:bordeaux';
  label: 'Bordeaux';
  entityType: 'region';
  attributes: {
    country: 'France';
    climate: 'maritime';
    grapeFamilies: ['cabernet', 'merlot'];
    regionHierarchy: ['France', 'Bordeaux'];
  };
};
```

필수 ontology edge 예시:

- `region -> country`
- `region -> region_hierarchy`
- `appellation -> region`
- `grape -> grape_family`
- `wine -> producer`
- `region/appellation -> typical_grape_family`
- `region/style -> expected_structure`

중요:

- ontology는 순수 retrieval 장식이 아니라 **추론 기반**이다.
- canonical entity와 derived facts는 별도 provenance를 가진다.
- ontology expansion은 hard/soft/inferred 층위를 구분해 산출해야 한다.

### 6.4 Stage 4: Constraint Expansion

Entity에서 곧바로 retrieval filter만 만드는 것이 아니라,
다층 constraint bundle을 만든다.

예:

```text
query: "보르도"

hard:
  region = Bordeaux

soft:
  country = France
  grape_family in [cabernet, merlot]

inferred:
  climate = maritime
```

또 다른 예:

```text
query: "샴페인"

hard:
  region = Champagne

soft:
  wine_type = sparkling
  country = France
  method = traditional

inferred:
  aging_potential = high
```

여기서 hard는 deterministic direct fact만 허용한다.
soft/inferred는 ontology expansion이나 interaction rule에서 생성한다.

### 6.5 Stage 5: Compositional Constraint Builder

이 단계가 SOTA++ 핵심이다.
독립 span을 그냥 병렬 매핑하지 않고, span 조합에서 구조적 속성을 유도한다.

예:

```text
["레드", "보르도", "2018"]
```

이것은 단순히:

- `wine_type=red`
- `region=Bordeaux`
- `vintage_year=2018`

으로 끝나지 않는다.

추가로 다음을 유도할 수 있다.

```text
inferred:
  grape_family in [cabernet, merlot]
  tannin >= medium
  aging_potential >= medium_high
```

예시 규칙:

```ts
if (region === 'Bordeaux' && wineType === 'red') {
  inferred.push({ attribute: 'tannin', operator: '>=', value: 3 });
  inferred.push({ attribute: 'grape_family', operator: 'in', value: ['cabernet', 'merlot'] });
}
```

이 규칙은 "지식 기반 prior"이지 hard fact가 아니다.
따라서 provenance를 `compositional_inference`로 명시하고,
retrieval에서는 기본적으로 boost/expansion에 사용한다.

### 6.6 Stage 6: Retrieval Plan Builder

현재는 대체로:

```text
constraint -> filter token
```

이다.

목표는:

```text
constraint bundle -> filter + boost + expansion query plan
```

예:

```text
hard:
  region = Bordeaux

soft:
  grape_family in [cabernet, merlot]

retrieval plan:
  WHERE region = "Bordeaux"
  OR region_hierarchy contains "Bordeaux"

  BOOST IF grape_family in ["cabernet", "merlot"]
  BOOST IF country = "France"
```

즉 NL Mapper 출력은 YQL filter 토큰의 공급원이 아니라,
**retrieval planner의 semantic IR**이 된다.

### 6.7 Stage 7: RFC-018 Integration

이 RFC는 `RFC-018`과 강하게 연결된다.

Before:

```text
NL Mapper -> weak constraints -> broad candidate pool -> noisy structure signals
```

After:

```text
NL Mapper ->
  region=Bordeaux
  grape_family=Cabernet
  tannin>=3
  aging_potential=high
-> structure-aware candidates
-> RFC-018 deterministic kinetics model
-> more stable drinking window estimates
```

핵심 요약:

- RFC-019는 RFC-018의 수학 모델을 바꾸지 않는다.
- RFC-019는 RFC-018이 받는 **입력 분포를 정제**한다.
- 즉 RFC-019는 RFC-018의 upstream semantic normalization layer다.

---

## 7. LLM 역할 재정의

현재 LLM은 fallback extractor처럼 보인다.
본 RFC에서 LLM의 역할은 다음으로 제한·승격한다.

### 7.1 허용 역할

- **entity linker**
- **ambiguity disambiguator**
- **surface-form normalizer for OOV phrases**

예:

```json
{
  "span": "나파 카베",
  "candidate_entity": "region:napa_valley",
  "confidence": 0.93,
  "reason": "Korean abbreviation of Napa + Cabernet context"
}
```

그 이후 단계:

- canonical entity ID 검증
- ontology traversal
- hard/soft/inferred 분류
- retrieval expansion

은 모두 deterministic layer가 담당한다.

### 7.2 금지 역할

- LLM이 hard constraint를 직접 생성하는 것
- ontology fact를 임의 발명하는 것
- retrieval plan을 비결정적으로 생성하는 것

### 7.3 캐시 전략

LLM 결과는 phrase cache가 아니라,
가능하면 **linked entity cache**로 저장한다.

예:

```text
"나파 카베" -> region:napa_valley
```

캐시 키에는 다음이 들어간다.

- normalized span text
- language
- resolver version
- ontology snapshot version

이렇게 해야 replayability가 유지된다.

---

## 8. 계측과 평가 지표

기존 지표는 유지하되, 중심 KPI를 semantic 품질로 옮긴다.

### 8.1 유지할 운영 지표

- `fallbackTriggered`
- `ruleTableHitCount`
- `llmHitCount`
- `llmLatencyMs`
- loaded mapping count

### 8.2 신규 핵심 KPI

#### 1. Semantic Constraint Recall

정의:

```text
SCR = (# extracted expected constraints) / (# ground-truth constraints)
```

예:

```text
query: "보르도 2018 레드"

GT:
  region=Bordeaux
  wine_type=red
  vintage>=2018

prediction:
  region=Bordeaux
  wine_type=red

SCR = 2 / 3
```

이 지표를 RFC-019의 대표 KPI로 삼는다.

#### 2. Entity Linking Accuracy

```text
ELA = correctly linked entity spans / all entity-bearing spans
```

#### 3. Ontology Expansion Precision

```text
OEP = valid expanded facts / all expanded facts
```

#### 4. Compositional Inference Precision

```text
CIP = valid inferred interaction constraints / all interaction constraints
```

#### 5. Retrieval Structural Yield

```text
RSY = queries producing >=2 structurally meaningful constraints / all queries
```

### 8.3 Trace 스키마 확장

```ts
interface ConstraintExtractionTrace {
  candidateSpanCount: number;
  resolvedEntityCount: number;
  directHardConstraintCount: number;
  ontologyExpandedConstraintCount: number;
  compositionalInferenceCount: number;
  fallbackTriggered: boolean;
  source: 'rule_only' | 'resolver' | 'resolver_plus_llm' | 'fallback';
  semanticConstraintRecall?: number;
  entityLinkingAccuracy?: number;
  phrasesByTier: {
    tier1_default_mapping: number;
    tier2_entity_resolver: number;
    tier3_ontology_expansion: number;
    tier4_compositional_inference: number;
    tier5_llm_linker: number;
    tier6_regex_fallback: number;
    unmapped: number;
  };
  categoriesCovered: string[];
  unresolvedSpanSamples: string[];
}
```

---

## 9. 구현 단계

### 9.1 Phase 1: Core Coverage Backbone

**상태**: 이미 착수 / 일부 반영

- `DEFAULT_MAPPINGS`를 core vocabulary backbone으로 확장
- wine_type / country / region / grape / appellation 기본축 확보
- v15 대비 fallback 비율 85.2% -> 51.7% 수준까지 감소

이 phase는 SOTA의 끝이 아니라,
다음 단계를 위한 bootstrap이다.

### 9.2 Phase 2: Entity Resolver Layer

**새 구성 요소**:

- `scripts/etl/generate-nl-mappings.ts`
- `data/nl-mappings.json`
- entity dictionary snapshot
- alias index
- ambiguity score metadata

자동 생성 규칙:

- canonical -> aliases 생성
- frequency-aware pruning
- ambiguity-aware confidence 조정
- conflict resolution priority 적용

우선순위:

```text
DEFAULT > ETL Resolver Snapshot > LLM Linker Cache
```

### 9.3 Phase 3: Ontology Snapshot

**새 산출물**:

- `data/entity-ontology.json` 또는 equivalent generated artifact

포함해야 할 것:

- entity nodes
- canonical label
- aliases
- parent/child hierarchy
- typical grape families
- style priors
- regional structure priors

여기서 ontology는 KB라기보다
**retrieval-safe deterministic inference graph**다.

### 9.4 Phase 4: Span Parser + Resolver Pipeline

**대상 파일**:

- `src/domain/query/service/planner.ts`
- `src/domain/attribute/service/nl-mapper.ts`
- 신규 `span-parser` 계층
- 신규 `entity-resolver` 계층

주요 변경:

- n-gram 중심 흐름을 span-centric 흐름으로 대체
- longest match 우선
- overlap/conflict resolution
- structured numeric span normalization

### 9.5 Phase 5: Compositional Inference Engine

**새 규칙군 예시**:

- `region + wine_type -> structure prior`
- `region + vintage -> aging prior`
- `grape + body adjective -> tannin/acidity prior`
- `sparkling + occasion -> boost rather than hard filter`

이 phase부터 NL Mapper는 mapping module이 아니라
실질적인 **semantic compiler**가 된다.

### 9.6 Phase 6: Retrieval Plan Integration

**대상 레이어**:

- retrieval query builder
- ranking feature extractor
- sparse filter token generation

출력 분리:

- hard -> exact filter
- soft -> boost / relaxed filter
- inferred -> expansion / ranking features

### 9.7 Phase 7: RFC-018 Downstream Alignment

RFC-018과 연결되는 구조 prior를 명시적으로 도입한다.

예:

- `grape_family=cabernet` -> higher tannin prior
- `region=Barolo` -> higher acidity/tannin prior
- `sparkling + Champagne` -> method / aging prior

이 값들은 RFC-018 입력을 직접 위반하지 않도록,
최종적으로는 existing input contract에 맞는 normalized signals로만 변환한다.

---

## 10. 성공 지표

### 10.1 단기 목표

| 지표 | 현재 (v15) | v16 측정 | 목표 |
|------|-----------|----------|------|
| `fallbackTriggered` 비율 | 85.2% | 51.7% | **<25%** |
| `rule/resolver hit` 쿼리 | 14.8% | 48.3% | **≥80%** |
| Mean hard constraints | 1.15 | 1.38 | **≥2.0** |
| Benchmark Ctx Relevance | 63.9% | 72.2% | **≥80%** |
| top-10 missed phrase coverage | 0% | ~60% | **100%** |

### 10.2 중기 목표

| 지표 | 목표 |
|------|------|
| Semantic Constraint Recall | **≥0.85** |
| Entity Linking Accuracy | **≥0.95** on top frequent spans |
| Ontology Expansion Precision | **≥0.90** |
| Compositional Inference Precision | **≥0.85** |
| Queries with >=2 structural constraints | **≥70%** |

### 10.3 최종 품질 기준

NL Mapper가 성공한 상태란,
단순히 phrase를 더 많이 잡는 상태가 아니다.
다음이 만족되어야 한다.

- query가 entity 단위로 이해된다.
- ontology fact가 retrieval plan에 반영된다.
- compositional inference가 구조적 prior를 제공한다.
- RFC-018 같은 deterministic downstream이 더 안정적인 입력을 받는다.

---

## 11. 테스트 전략

### 11.1 단위 테스트

- span longest-match 테스트
- alias -> entity resolution 테스트
- ambiguity resolution 테스트
- ontology expansion 테스트
- composition rule 테스트

### 11.2 회귀 테스트

신규:

- `test/regression/nl-mapper-coverage.regression.test.ts`
- `test/regression/entity-resolver.regression.test.ts`
- `test/regression/ontology-expansion.regression.test.ts`
- `test/regression/compositional-inference.regression.test.ts`

핵심 회귀 케이스:

- `"레드 와인"`이 `"레드"` + `"와인"`으로 잘못 분해되지 않는지
- `"보르도"`가 `country=Bordeaux` 같은 잘못된 attribute로 가지 않는지
- `"샴페인"`이 region/wine_type 양쪽 의미를 안정적으로 처리하는지
- `"나파 카베"`가 OOV linker 경로를 통해 결정적으로 entity cache에 안착하는지
- `"보르도 2018 레드"`가 최소 3개 핵심 constraint를 회수하는지

### 11.3 오프라인 평가셋

golden query에 대해 다음 GT를 부착한다.

- expected entities
- expected hard constraints
- acceptable soft constraints
- acceptable inferred constraints

이 데이터로 semantic recall과 expansion precision을 계산한다.

---

## 12. Out of Scope

- embedding model 자체 변경
- LLM cost 최적화 정책
- RFC-004의 allowed attribute 집합 자체 변경
- RFC-018의 수학 모델 변경
- 완전 자유형 knowledge graph 연구 프로젝트화

본 RFC의 범위는 어디까지나
**검색 시스템에 안전하게 들어갈 수 있는 ontology-driven semantic compiler**를 만드는 것이다.

---

## 13. 리스크 및 완화

| 리스크 | 영향 | 완화 |
|--------|------|------|
| Auto-generated entity snapshot drift | 잘못된 canonicalization | Silver/ETL 버전과 ontology snapshot 동기화 |
| Phrase ambiguity 증가 | 잘못된 entity linking | ambiguity score + linker confidence threshold + regression test |
| Over-expansion으로 retrieval noise 증가 | precision 하락 | hard/soft/inferred 분리 + expansion precision metric |
| Compositional rule 과잉 일반화 | 잘못된 structure prior | rule provenance 명시 + offline eval gating |
| LLM linker hallucination | 잘못된 entity cache 오염 | canonical entity whitelist 검증 + unresolved fallback |
| 외부 파일 로드 실패 | resolver 무력화 | `DEFAULT_MAPPINGS` backbone 유지 + startup error |

---

## 14. 최종 요약

지금의 NL Mapper는 잘 만든 phrase mapping 시스템이다.
그러나 업계/학계 SOTA++ 기준에서는 아직 **semantic compiler 이전 단계**다.

본 RFC의 최종 제안은 다음 5개를 반드시 추가하는 것이다.

1. **Span-based parsing**
2. **Entity Resolver Layer**
3. **Ontology-driven constraint expansion**
4. **Compositional inference engine**
5. **Semantic recall 중심 평가 체계**

한 줄 결론:

> 지금은 "phrase matching system"이고,
> 목표는 **"ontology-driven semantic compiler"** 다.

---

## 15. 참고

- `RFC-004`
- `RFC-005`
- `RFC-012`
- `RFC-018`
- `src/domain/attribute/service/nl-mapper.ts`
- `src/domain/attribute/service/llm-nl-mapper.ts`
- `src/infrastructure/adapter/file-mapping-table.ts`
- `scripts/etl/generate-korean-aliases.ts`
- `test/benchmark/agent/results/quick-v15-final-full.log`
- `test/benchmark/agent/results/quick-v16-structural-stderr.txt`

---

## 16. 2026-04-09 Audit Update (standard, judge 포함)

실행 커맨드:

- `npx tsx test/benchmark/agent/runner.ts --profile standard`

핵심 결과(104 scenarios, judge on):

- Overall: **82.5%**
- Faithful: **79.8%**
- Judge: **61.3%**
- SCR overall: **57.7%** (`hard 52.6 / soft 70.6 / inferred 50.0`)
- ELA@1: **90.3%** (TAC KBP 92% 목표 근접)
- Slot F1 strict/relaxed: **37.6% / 39.4%**

### 16.1 Audit Findings (우선순위)

1) **[P0] Tool-action schema 안정성 부족 (tool=0% 케이스 잔존)**

- 증상:
  - worst bucket에서 `tool=0%`가 반복 (`#5`, `#52`, `#202`).
  - 일부 step에서 잘못된 structured input이 전달됨 (예: `exclude_grapes: [""]`).
- 영향:
  - 올바른 retrieval/grounding 이전 단계에서 실패하여 judge 급락.
- 구조적 개선:
  - Agent action JSON을 실행 전 **강제 정규화/정합화 레이어**로 통과:
    - 빈 문자열 배열 항목 제거
    - 상호배타/불필요 필드 정리
    - tool별 strict input contract 재검증 후 실행
  - `Invalid input for search_wines` 발생 시 즉시 재시도 가능한 **자동 교정 branch**를 orchestrator에 추가.

2) **[P0] Judge/Faithfulness 갭이 큰 시나리오군 존재 (근거-응답 매핑 약함)**

- 증상:
  - gift/nested/comparison 일부에서 judge=0.00이 반복 (`#34`, `#88`, `#25` 포함).
  - Faithful 79.8% 대비 Judge 61.3%로 격차 큼.
- 영향:
  - “도구는 썼지만 답변이 평가 기준에 맞게 grounded되지 않음”.
- 구조적 개선:
  - `GROUNDING_JSON`을 최종 답변 생성 시 **필수 참조 포맷**으로 강제.
  - answer 렌더링 전 claim-level 검증에서
    - evidence anchor 없는 문장/개체명 차단
    - tool observation에 없는 속성(가격/지역/스타일) 자동 삭제 또는 “확인 불가”로 강등.

3) **[P1] Hard constraint 밀도 부족**

- 증상:
  - benchmark insight에서 `Mean hard constraints` 저평가 경고 지속.
  - SCR hard(52.6)와 Slot F1(37.6) 동반 저조.
- 영향:
  - 쿼리 의도 대비 retrieval filter가 약해 precision 저하.
- 구조적 개선:
  - soft-only로 남는 제약 중 “검색 필수 제약”을 hard 승격하는 정책 재정의:
    - wine_type / negation / explicit price cap / explicit vintage 범위
  - planner trace에 “hard 승격 이유”를 남기고 회귀 테스트로 고정.

4) **[P1] ELA@1 90.3% — 마지막 alias gap**

- 증상:
  - 92% 목표 직전에서 정체.
- 영향:
  - 한국어 붙여쓰기/축약형에서 canonical miss 가능.
- 구조적 개선:
  - alias SSOT를 유지한 채,
    - `DEFAULT_MAPPINGS` ↔ resolver 동기화 경로를 계속 사용
    - compact key + 한글 축약형(도메인 빈도 상위) 확장
  - 신규 alias는 반드시 regression + benchmark annotated scenario로 동시 검증.

### 16.2 즉시 반영 가능한 Backlog

- [ ] `agent-tools` 입력 정규화 모듈 추가 (빈 문자열/중복/금지값 제거)
- [ ] orchestrator에 “tool input invalid → auto-repair 1회” 경로 추가
- [ ] answer synthesis 단계에서 `GROUNDING_JSON` 기반 whitelist renderer 적용
- [ ] claim verifier noise token 필터(문법 토큰/조사/메타문구) 강화
- [ ] benchmark scenario annotation 확장 (현재 constraint evaluated coverage 확대)
- [ ] ELA 잔여 miss surface 수집 후 alias pack v2 반영

### 16.3 운영 원칙

- 단순 phrase 추가가 아니라 **파이프라인 계층(입력 정규화 → 제약 강제 → 근거 렌더링)**으로 고친다.
- 모든 개선은:
  1. 회귀 테스트 추가
  2. benchmark 재실행(quick + standard)
  3. 지표 변화 기록
  순서로 반영한다.

---

## 17. 2026-04-09 Audit Update #2 (로그 패턴 기반 추가 점검)

동일 실행(`standard`, judge on)에서 추가로 관찰된 패턴:

- `agent LLM emitted bare tool call (missing action wrapper); recovered`가 반복
- `agent LLM produced non-JSON output; falling back to raw text`가 반복
- `#34`에서 `terminationReason=fallback` + `term=25%`
- `conformalSetSize=0` 경고가 다수 쿼리 클래스에서 반복
- 부트 단계에서 `nl-mappings.json` 부재 및 `LTR models empty` 경고
- 지표 간 괴리: `Faithful 79.8%` vs `Faithful (claim) 1.3%`

### 17.1 추가 Findings

1) **[P0] LLM 출력 포맷 안정성 부족 (JSON contract drift)**

- 증상:
  - bare tool-call / non-JSON output이 반복적으로 복구 경로를 탐.
- 영향:
  - 복구는 되지만, step budget 소모/의도 손실/termination miss 가능성이 증가.
- 개선:
  - orchestrator 응답 파서 앞단에 **JSON schema gate**를 두고,
    - 불완전 JSON은 재질의(1회) 후 실행
    - bare tool-call은 허용하되 telemetry로 별도 집계해 품질 게이트화.

2) **[P0] Fallback termination 품질 이슈**

- 증상:
  - `#34`가 fallback 종료로 term score 하락.
- 영향:
  - 비교형 시나리오에서 tool-flow가 시작도 못 하고 종료될 수 있음.
- 개선:
  - comparison intent에서 step0 fallback 금지 가드 추가:
    - 최소 1회 `compare_wines` 또는 2-way `search_wines` 실행 보장 후 종료 허용.

3) **[P1] Conformal gate 신호 약화 (`conformalSetSize=0`)**

- 증상:
  - 다양한 queryClass에서 empty conformal set 경고 반복.
- 영향:
  - authoritative 판단 신뢰 저하, heuristic 경로 비중 증가.
- 개선:
  - conformal calibration 데이터 재생성 + queryClass별 최소 표본수 보장.
  - empty-set 발생 시 deterministic backup threshold를 명시적으로 적용.

4) **[P1] 런타임 아티팩트 의존성 누락**

- 증상:
  - `nl-mappings.json` 없음, LTR 모델 없음.
- 영향:
  - alias/LTR 품질이 baseline 대비 저하될 가능성.
- 개선:
  - 벤치 시작 전 **artifact preflight**를 강제:
    - 필수 파일/모델 누락 시 hard-fail 또는 degraded-run 라벨링.

5) **[P1] Faithfulness 메트릭 체계 불일치**

- 증상:
  - sentence-level faithfulness와 claim-level faithfulness가 크게 분리.
- 영향:
  - 실제 개선 우선순위 판단이 흔들림.
- 개선:
  - claim extractor의 토큰 노이즈 필터(조사/메타문구) 강화
  - claim-level verdict를 최종 faithfulness 계산에 반영하는 가중 규칙 재정의.

### 17.2 추가 Backlog

- [ ] `AgentOrchestrator` JSON gate + retry-on-malformed(1회) 구현
- [ ] comparison intent fallback guard 회귀 테스트 추가
- [ ] conformal empty-set 발생률 리포트(클래스별) + 캘리브레이션 잡 재구성
- [ ] benchmark preflight(check artifacts) 도입
- [ ] claim extractor 노이즈 토큰 stoplist + claim-level faithfulness 재보정
