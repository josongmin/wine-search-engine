# Appendix C: Evolutionary Architecture for Ongoing SOTA Updates

이 appendix는 “앞으로도 논문, 벤치마크, 모델, 운영 요구가 계속 바뀔 텐데  
이걸 매번 엔진 전체 rewrite 없이 건강하게 받아들이려면 어떤 구조로 가야 하는가”를 정리한다.

핵심 원칙은 단순하다.

> SOTA++를 지향하는 엔진은 “오늘 최고의 모델”을 하드코딩하는 구조가 아니라,  
> “새 retriever / reranker / gate signal / benchmark를 흡수할 수 있는 policy architecture”여야 한다.

---

## 1. 왜 이 appendix가 필요한가

검색 엔진은 시간이 지나면 거의 반드시 바뀐다.

- 더 좋은 embedding 모델이 나온다
- learned sparse가 더 강해진다
- late interaction의 serving cost가 내려간다
- reranker가 교체된다
- benchmark가 바뀌고 failure slice가 추가된다
- business / UX 요구가 생긴다

이때 아키텍처가 건강하지 않으면 매번 아래가 반복된다.

- query classifier 수정
- candidate pool 수정
- ranker 수정
- API 설명 수정
- eval slice 수정

즉 같은 개념 변경이 시스템 전역으로 번진다.

`apr-7-v0.4`의 목표는 이런 상태를 막는 것이다.

---

## 2. 건강한 구조의 기준

### 2.1 model-specific code를 policy-specific code로 승격하지 않는다

예:

- `bge_m3`를 직접 route의 중심으로 두지 않는다
- `colbertv2`를 query taxonomy의 일부로 두지 않는다
- `cross_encoder_x`를 scoring contract의 고정 필드로 두지 않는다

대신 추상화:

- retriever family: `dense`, `learned_sparse`, `late_interaction`
- reranker family: `cross_encoder`, `ltr`, `listwise`
- fusion contract: normalized lane score + provenance

즉 모델 이름은 adapter에 남기고, policy는 capability 기준으로 써야 한다.

### 2.2 query understanding contract를 retrieval implementation과 분리한다

query contract는 아래를 안정적으로 제공해야 한다.

- dominant intent
- side intents
- constraints
- anchor / relative ops
- ambiguity / exact confidence
- route complexity / value weight

이 계약은 특정 retriever가 바뀌어도 유지돼야 한다.

즉 retriever는 query contract의 소비자이지, query contract의 정의자가 되면 안 된다.

### 2.3 lane registry를 둔다

새 retrieval 방식은 “기존 candidate pool if문 추가”로 붙이면 안 된다.

권장 구조:

```text
lane_id
lane_family
cost_class
supports_exact
supports_semantic
supports_anchor
supports_structured
serving_constraints
default_budget
feature_exports
```

이렇게 하면 새 lane이 들어와도:

- registry 등록
- policy table에 연결
- eval slice에 추가

정도로 확장할 수 있다.

### 2.4 fusion, gate, ranking은 table-driven이어야 한다

하드코딩된 if문보다 아래처럼 가야 한다.

- intent별 lane mix table
- intent별 candidate budget table
- rerank gate signal weights
- explanation requirement table
- eval slice mapping table

즉 새 query family나 새 모델이 들어와도 로직 전체를 다시 쓰지 않고 policy를 갱신해야 한다.

### 2.5 ranking stages는 독립 계약이어야 한다

권장 stage:

- `R0 assembly`
- `R1 cheap rank`
- `R2 expensive rerank`
- `R3 policy apply`

그리고 각 stage는 아래를 명시적으로 받아야 한다.

- input envelope
- feature set
- score output
- provenance
- degradation reason

그래야 새 reranker를 넣거나 뺄 때 전체 ranker를 갈아엎지 않는다.

### 2.6 explanation contract는 ranking evidence와 결합돼야 한다

설명은 free-form generation이 아니라 evidence slot 기반이어야 한다.

예:

- `sensory_reason`
- `pairing_reason`
- `anchor_similarity_reason`
- `constraint_satisfaction_reason`

새 모델이 들어오면 explanation text를 다시 쓰는 게 아니라, evidence source를 더 공급하는 방향으로 가야 한다.

### 2.7 eval taxonomy는 구현보다 오래 살아야 한다

benchmark나 model은 바뀌지만, 아래 slice는 오래 유지돼야 한다.

- exact entity
- structured filter
- sensory
- pairing
- substitute
- broad
- long-NL
- multilingual / transliteration
- low-metadata / long-tail

즉 eval은 현재 구현을 반영하는 게 아니라, **사용자 문제 공간을 반영하는 taxonomy**여야 한다.

---

## 3. 앞으로의 업데이트를 흡수하는 구체 구조

### 3.1 retriever 추가

새 dense 또는 sparse 모델이 나왔을 때:

- lane registry에 새 lane 추가
- offline eval에 lane ablation 추가
- policy table에서 일부 intent에만 실험 연결

필수적으로 바뀌지 않아야 하는 것:

- query taxonomy
- response contract
- explanation schema

### 3.2 reranker 교체

새 cross-encoder 또는 listwise reranker가 나왔을 때:

- `R2 precision rerank` adapter만 교체
- gate signal과 top-K budget만 재튜닝

필수적으로 바뀌지 않아야 하는 것:

- retrieval lanes
- query parsing
- evidence category schema

### 3.3 benchmark 추가

새 benchmark나 새로운 failure slice가 생기면:

- eval taxonomy에 새 slice 추가
- promotion gate 갱신

필수적으로 바뀌지 않아야 하는 것:

- online serving contracts
- planner core contract

### 3.4 business / UX 요구 추가

예:

- premium catalog 우선
- gift explanation 강화
- stock/ETA 반영

이런 요구는 `policy apply`와 `explanation requirement table`에서 처리해야 한다.

필수적으로 바뀌지 않아야 하는 것:

- core relevance score definition
- retrieval lane semantics

---

## 4. 현재 레포 기준으로 특히 주의할 점

현재 레포는 이미 아래 자산이 있다.

- query understanding 스캐폴드
- retrieval channel vocabulary
- rerank/LTR scaffold
- eval/replay/contract safety

하지만 지금 그대로는 future-proof하지 않은 부분이 있다.

### 4.1 intent/class/family/mode의 다중 권위

이 상태는 새 query family가 추가될 때 계층별 drift를 만든다.

따라서 앞으로의 구조 원칙은:

- query taxonomy SSOT 하나
- 나머지는 projection 또는 derived view

여야 한다.

### 4.2 retrievalMode 중심 분기 남용

retrievalMode가 실행 편의상 많은 걸 결정하면, 새 lane이 늘어날수록 분기가 폭발한다.

권장 방향:

- retrievalMode는 coarse execution hint
- lane mix / budget / gate는 table-driven policy

### 4.3 ranker 내부에 CE/LTR를 같이 묶는 구조

새 precision model을 추가할수록 `Ranker`가 비대해질 수 있다.

권장 방향:

- stage contract 분리
- `R1 ranker`
- `R2 reranker`
- `R3 policy adjuster`

### 4.4 evidence와 eval 이름 mismatch 방지

evidence type, ranking feature, eval metric은 이름 drift가 나기 쉽다.

권장 방향:

- canonical evidence vocabulary
- canonical ranking signal vocabulary
- eval metric이 그 vocabulary만 참조

---

## 5. architecture 원칙 요약

앞으로의 SOTA 업데이트를 건강하게 받으려면 아래를 지켜야 한다.

1. `taxonomy first`
새 모델보다 query/problem taxonomy를 먼저 고정한다.

2. `capability over implementation`
모델 이름이 아니라 lane family / reranker family / evidence family로 설계한다.

3. `table-driven policy`
lane mix, budget, gate, explanation, eval slice는 코드 분기보다 정책 표로 유지한다.

4. `stage separation`
assembly, cheap rank, expensive rerank, policy apply를 분리한다.

5. `stable evidence schema`
설명과 eval이 같은 evidence vocabulary를 쓴다.

6. `eval taxonomy as contract`
새 benchmark는 추가하되, 사용자 문제 공간 taxonomy는 흔들지 않는다.

---

## 6. 한 줄 결론

SOTA++ 엔진을 건강하게 운영하려면  
`새 모델을 쉽게 붙일 수 있는 구조`보다  
`새 모델이 들어와도 query contract / policy tables / stage contracts / evidence schema가 흔들리지 않는 구조`
가 더 중요하다.

즉 앞으로의 작업 방향은:

- “오늘 제일 좋은 모델”을 박아 넣는 것이 아니라
- “내일 더 좋은 모델이 나와도 lane 하나, reranker 하나, eval slice 하나로 수용되는 구조”

로 가는 것이다.
