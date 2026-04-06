# Epic 3: Candidate Pool + Provenance Rewrite

**성격:** must  
**목표:** candidate generation을 단순 점수 merge가 아니라 channel-aware, provenance-rich assembly로 재정의한다.  
**의존성:** Epic 1, Epic 2

---

## 왜 필요한가

지금의 [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)는 hybrid retrieval orchestration으로는 괜찮다.  
하지만 앞으로 learned sparse, stronger anchor retrieval, query-dependent ranking을 넣으려면 candidate 자체가 더 풍부한 envelope를 가져야 한다.

즉 이 epic은 recall만이 아니라 **candidate contract 재설계**다.

---

## 목표 상태

```text
query views
  -> channel-specific retrievers
  -> candidate envelopes with provenance
  -> structured assembly
  -> protected coverage / dedupe / diversity
  -> ranking-ready pool
```

---

## 레포에서 건드리는 축

- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts)
- [hybrid-candidate.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/hybrid-candidate.ts)
- [retrieval-trace.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-trace.ts)
- [fusion.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/fusion.ts)

---

## In Scope

- candidate envelope contract
- provenance vocabulary
- channel-aware assembly
- dedupe / merge semantics
- retrieval observability alignment

## Out Of Scope

- learned sparse training/serving
- late interaction
- final ranking stage redesign

---

## 핵심 작업

### Step 1. Candidate envelope 정의

candidate는 최소한 아래 provenance를 가져야 한다.

- source channel
- matched query view
- raw sparse/dense/channel score
- filter application 결과
- anchor-conditioned 여부
- protected inclusion 이유

### Step 2. Structured assembly layer 도입

RRF만으로 끝내지 않고:

- channel quota
- source diversity
- anchor coverage
- exact/known-item 보호
- constraint-compatible 후보 보호

를 보장하는 assembly를 도입한다.

### Step 3. Dedupe / merge semantics 재정의

동일 entity가 여러 채널에서 들어왔을 때 단순 overwrite가 아니라 multi-source evidence를 누적해야 한다.

### Step 4. Trace / observability alignment

runtime 로그와 offline eval이 같은 provenance vocabulary를 쓰게 맞춘다.

### Step 5. Protected recall policy

known-item, exact alias, anchor-conditioned, hard-constraint-compatible 후보를 assembly 단계에서 보호하는 규칙을 정의한다.

---

## 설계 원칙

1. candidate pool은 retrieval의 최종 결과가 아니라 ranking 입력이다.
2. provenance 없는 recall 증가는 장기적으로 독이다.
3. assembly policy는 ranking policy와 분리한다.
4. known-item과 discovery query는 같은 merge 정책을 쓰지 않는다.

---

## 완료 기준

- 모든 candidate가 channel provenance를 가진다.
- candidate merge가 overwrite가 아니라 evidence accumulation 기반이 된다.
- pool assembly가 query family에 따라 정책적으로 달라질 수 있다.
- ranking은 candidate provenance를 잃지 않고 입력받는다.

## 검증 전략

- candidate merge unit tests
- provenance serialization tests
- retrieval assembly integration tests
- offline eval slice 비교
