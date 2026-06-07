# RFC-021 — Primitive Search Surface and Agent-Orchestrated Query Composition

**상태**: Draft
**작성일**: 2026-06-01
**상위·연관 문서**
- `RFC-005` — Query planner·Policy compiler
- `RFC-011` — Mixed query solver
- `RFC-012` — Hybrid retrieval
- `RFC-014` — Search API·external contract
- `RFC-000` — Master Architecture

**충돌 시 `RFC-014` 외부 계약, `RFC-012` retrieval semantics, `RFC-000` SSOT가 우선한다.**

---

## 0. 한 줄 방향

> **Public search는 deterministic primitive surface로 유지하고, long-tail composition은 agent가 primitive를 조합해서 처리한다.**

이 RFC는 **최종 SOTA retrieval design 선언문이 아니다.**
이 RFC는 오히려, SOTA에 필요한 search/agent 경계를 먼저 바로잡는 **중간 단계 구조 RFC**다.

이 RFC의 핵심은 두 가지다.

1. `/v1/search/*`와 `lookup`은 **비-agentic, deterministic** search primitive로 유지한다.
2. `"오푸스원 비슷한 와인"`, `"A vs B"`, 다단계 추천 같은 **composition 문제**는 agent가 primitive를 호출해 해결한다.

단, ranking truth, fusion, rerank, identity resolution은 여전히 **search core authority**로 남는다.

---

## 1. Problem Statement

현재 구조에는 두 종류의 문제가 섞여 있다.

### 1.1 Public search에 의미 해석 권한이 과도하게 들어가 있다

현재 planner는 query surface를 보고:

- `intent`
- `route`
- `retrievalMode`
- constraint parsing query

까지 한 번에 결정한다.

이 구조는 `"오푸스원 비슷한 와인"` 같은 쿼리에서 취약하다.

- 한국어 `비슷한` marker가 early `mixed_query`를 유발한다.
- 이후 anchor가 constraint parsing surface에서 strip된다.
- residual이 generic surface로 축소되면, retrieval은 reference-conditioned similarity가 아니라 generic recommendation처럼 붕 뜬다.

즉 문제는 "한국어 support 부족"이 아니라,
**planner heuristic이 public search 의미 자체를 너무 많이 결정한다**는 점이다.

### 1.2 Agent가 search core가 해야 할 일을 가져가면 안 된다

반대로 `"semantic + lexical 두 primitive만 남기고 agent가 다 하자"`도 정석은 아니다.

그렇게 되면 agent가 매번 직접 처리해야 한다.

- dense / sparse 결과셋 merge
- score normalization
- dedupe
- fusion
- rerank
- same-entity / same-producer suppression
- provenance 생성

이것은:

- 비결정적
- 느림
- 비쌈
- 회귀 추적이 어려움
- ranking truth가 모델 프롬프트 안으로 새는 구조

가 된다.

### 1.3 이 RFC의 범위와 비목표

이 RFC가 직접 해결하는 것:

- public search와 agent의 책임 경계 정리
- primitive/tool taxonomy 정리
- planner heuristic authority 축소 방향 정리

이 RFC가 직접 해결하지 않는 것:

- learned reranker 성능 최적화
- entity linker 자체의 품질 상한
- online feedback / LTR 학습
- multilingual retrieval 품질의 최종 상한

즉 이 문서는 **품질 상한을 즉시 끌어올리는 RFC**가 아니라,
품질 상한을 올릴 수 있는 **구조적 전제**를 정리하는 RFC다.

---

## 2. 현재 상태와 이미 있는 자산

현재 코드베이스는 이미 primitive split의 초석을 갖고 있다.

### 2.1 HTTP primitive surface는 이미 존재한다

`src/interface/http/routes/primitive-search.route.ts`

- `POST /v1/search/hybrid`
- `POST /v1/search/semantic`
- `POST /v1/search/lexical`
- `POST /v2/entity-lookup`

이 라우트들은 path가 lane authority다. body가 lane을 override하지 않는다.

### 2.2 Tool contract에도 exact lookup surface가 있다

`src/application/search/search-tool-contract.ts`

- `lookup_wine`은 "특정 와인 identity를 정확히 찾는 primitive"로 이미 설명돼 있다.
- 반대로 discovery는 `search_hybrid/search_semantic/search_lexical`이 맡게 되어 있다.

### 2.3 Agent adapter도 일부 caller-controlled planner bypass를 이미 쓴다

`src/application/search/agent-tool-request-adapter.ts`

- tool retrieval mode가 `entity` / `mixed`가 아니면 caller authority로 planner bypass가 가능하다.

즉, 완전히 새 철학이 필요한 상태는 아니다.
문제는 이 seam이 **끝까지 정리되어 있지 않다**는 점이다.

---

## 3. 설계 원칙

### 3.1 Public search는 non-agentic이어야 한다

`/v1/search/*`는 대화형 reasoning surface가 아니라
**deterministic retrieval primitive**여야 한다.

Public search는:

- 입력
- 구조화된 constraint
- retrieval lane
- ranking evidence

에 대해 replayable 해야 한다.

### 3.2 Agent는 orchestration을 맡고 ranking truth는 맡지 않는다

Agent의 책임:

- query decomposition
- primitive selection
- multi-step tool sequencing
- clarification / conversation
- 최종 natural-language synthesis

Search core의 책임:

- entity resolution
- candidate generation
- lexical/semantic retrieval
- fusion
- rerank
- constraint filtering
- provenance / evidence

### 3.3 Planner는 authority가 아니라 helper여야 한다

Planner heuristic은 남을 수 있다.
하지만 public search 의미를 final authority처럼 결정하면 안 된다.

Planner의 역할은 최대한 여기까지로 줄어야 한다.

- generic search에서의 보조 compile
- tool/agent 호출이 없는 direct query에 대한 conservative defaulting

Planner가 가져가면 안 되는 권한:

- language-specific marker만으로 long-tail semantic intent를 강하게 확정
- reference similarity를 generic `mixed_query`로 축약
- public search surface를 agentic behavior로 drift시키기

---

## 4. 제안 아키텍처

### 4.1 계층 분리

| 계층 | 책임 | 금지 |
|------|------|------|
| Public search HTTP | primitive invocation, deterministic contract | long-tail conversational reasoning |
| Search core | lookup, retrieval, fusion, rerank, evidence | user-facing multi-step conversation |
| Agent | decomposition, primitive orchestration, synthesis | ranking truth, score normalization SSOT |

### 4.2 Primitive set

최소 primitive set은 다음이어야 한다.

1. `lookup_wine(query)`
2. `search_lexical(query, filters, limit)`
3. `search_semantic(query, filters, limit)`
4. `search_hybrid(query, filters, limit)`
5. `similar_to_entity(entity_id, filters?, limit)` 또는 동등한 `reference_similarity(...)`

핵심은 `5`다.

`"X 비슷한 와인"`은 text-only generic hybrid로 처리하는 게 아니라:

1. `lookup_wine("X")`
2. canonical `entity_id` 확정
3. `similar_to_entity(entity_id, optional_constraints)`

로 처리해야 한다.

이 primitive는 deterministic해야 한다.

- same entity exclusion
- near-duplicate suppression
- same producer diversification policy
- style / region / price proximity scoring
- provenance

를 search core가 소유한다.

### 4.3 왜 `semantic + lexical` 두 개만으로는 부족한가

두 primitive만 남기면 agent가 fusion engine 역할까지 하게 된다.

그 결과:

- dedupe 기준 drift
- score scale drift
- prompt/version에 따른 ranking non-determinism
- provenance 불일치
- regression test difficulty 증가

가 발생한다.

따라서 `hybrid` 또는 별도 `fuse_and_rerank` capability는 search core에 남아야 한다.

동일한 이유로 `lookup_wine`도 search core primitive여야 한다.
anchor resolution을 agent prompt에 위임하면 identity authority가 사라진다.

### 4.4 이 구조가 곧바로 SOTA를 의미하지는 않는다

이 구조만으로는 아직 부족하다.

이 RFC가 보장하는 것은:

- owner boundary 정리
- deterministic orchestration 기반 확보
- public search semantic drift 억제

이 RFC가 아직 보장하지 못하는 것은:

- 최상위 retrieval relevance
- 최상위 similarity ranking quality
- multilingual hard-case generalization
- learned ranking 최적화

따라서 이 RFC는 **SOTA 그 자체**가 아니라
**SOTA-friendly architecture baseline**으로 읽어야 한다.

---

## 5. Query Family별 처리 방식

### 5.1 Generic discovery

예:

- `"가벼운 피노 누아"`
- `"5만원 이하 보르도"`

처리:

- public `search_hybrid`
- 또는 agent가 직접 `search_hybrid` 호출

여기서는 planner 보조 compile이 허용된다.
하지만 contract는 여전히 generic hybrid search다.

### 5.2 Exact identity lookup

예:

- `"Opus One 2018"`
- `"오퍼스 원"`

처리:

- `lookup_wine`

이 쿼리를 generic discovery와 섞으면 안 된다.

### 5.3 Reference-conditioned similarity

예:

- `"오푸스원 비슷한 와인"`
- `"similar wine to opus one"`

처리:

1. `lookup_wine(anchor_surface)`
2. `similar_to_entity(entity_id, optional_constraints)`

여기서 중요한 점:

- anchor는 hard filter가 아니다.
- 그렇다고 parsing 단계에서 잃어버려도 안 된다.
- anchor는 **reference entity**로 유지되어야 한다.

### 5.4 Comparison / multi-entity reasoning

예:

- `"Opus One vs Sassicaia"`
- `"오퍼스원이랑 스크리밍 이글 중 뭐가 더 진해"`

처리:

1. `lookup_wine(A)`
2. `lookup_wine(B)`
3. comparison primitive 또는 agent synthesis

비교 reasoning은 agent가 맡아도 된다.
하지만 entity resolution은 search core authority여야 한다.

---

## 6. Public API와 Tool Surface 제안

### 6.1 Public HTTP

유지:

- `POST /v1/search/hybrid`
- `POST /v1/search/semantic`
- `POST /v1/search/lexical`
- `POST /v2/entity-lookup`

선택지:

- `POST /v1/search/similar`

단, `similar_to_entity`는 우선 internal tool primitive로 먼저 도입하는 편이 안전하다.
external contract로 공개할지는 별도 결정으로 분리한다.

### 6.2 Agent tool surface

권장 tool taxonomy:

1. `lookup_wine`
2. `search_hybrid`
3. `search_semantic`
4. `search_lexical`
5. `similar_to_entity`
6. `compare_wines` 또는 comparison synthesis helper

비권장:

- `mixed` 같은 광의 heuristic bucket을 agent-facing primary tool로 노출

`mixed`는 legacy compatibility를 위해 내부에 남을 수는 있어도,
새 호출 surface의 중심 개념이 되어서는 안 된다.

---

## 7. Migration Plan

### Phase 0. Contract freeze

- public `/v1/search/*`는 non-agentic primitive contract라는 원칙을 명시
- `/v1/search` 계열이 agent orchestration path로 drift하지 못하게 테스트 고정

### Phase 1. Deterministic reference-similarity primitive 추가

- internal `similar_to_entity(entity_id, filters?, limit)` 도입
- retrieval / fusion / rerank / provenance를 search core에서 완결

### Phase 2. Agent orchestration 전환

- `"X 비슷한 와인"` 계열은 `lookup_wine -> similar_to_entity` 2-step으로 전환
- `"A vs B"` 계열은 `lookup -> lookup -> compare/synthesize`로 전환

### Phase 3. Planner authority 축소

- public search에서 `mixed_query` 같은 heuristic intent의 authority를 축소
- language-specific marker가 route truth를 직접 결정하지 못하게 정리

### Phase 4. Legacy mode 정리

- `mixed` retrieval mode를 public / tool primary surface에서 제거 후보로 전환
- 필요 시 internal compatibility alias로만 유지

---

## 8. 검증 계획

### 8.1 Contract / route tests

- primitive route selector는 path-authoritative여야 한다
- public search route가 agent path로 drift하지 않아야 한다

### 8.2 Agent orchestration tests

- `lookup_wine -> similar_to_entity`
- `lookup_wine -> lookup_wine -> compare`

### 8.3 Query regression set

최소 회귀 셋:

1. `"오푸스원"`
2. `"opus one"`
3. `"오푸스원 비슷한 와인"`
4. `"opus one similar wine"`
5. `"오푸스원 vs 사씨카이아"`

여기서 확인할 것:

- anchor preservation
- entity_id sealing
- same-entity exclusion
- external response determinism

### 8.4 Observability

trace에는 최소한 다음이 남아야 한다.

- primitive invocation chain
- lookup result / selected entity_id
- similarity primitive inputs
- fusion / rerank provenance

---

## 9. Tradeoffs

### 장점

- public search semantics가 단순해진다
- agent와 search core의 owner boundary가 명확해진다
- Korean/English heuristic drift를 구조적으로 줄인다
- ranking truth가 prompt 안으로 새지 않는다

### 비용

- agent path는 multi-call latency가 늘 수 있다
- `similar_to_entity` primitive를 제대로 설계해야 한다
- lookup 실패 / ambiguity에 대한 orchestration policy가 필요하다

### 실패 모드

- `lookup_wine` quality가 낮으면 agent orchestration 전체가 흔들린다
- `similar_to_entity`가 약하면 planner-heavy path를 지운 뒤 recall이 오히려 나빠질 수 있다
- public HTTP와 tool taxonomy가 따로 놀면 contract drift가 생긴다

### 아직 남는 SOTA gap

이 구조를 적용해도 아래가 없으면 retrieval quality 상한은 낮다.

- stronger entity linker
- hybrid 뒤 learned reranker
- reference similarity 전용 scoring/eval
- query family별 golden set과 hard regression rail
- online feedback 또는 pairwise preference 기반 ranking 개선

즉, 이 RFC는 architecture correction이고,
**ranking excellence 자체는 다음 단계 작업**이다.

---

## 10. Open Questions

1. `similar_to_entity`를 external HTTP로 공개할지, internal tool로만 둘지
2. `search_hybrid`를 유지할지, `semantic + lexical + fuse_and_rerank`로 더 분해할지
3. similarity에서 same producer를 boost할지 diversify할지
4. lookup ambiguity가 남을 때 agent가 clarify할지, top-k fanout을 허용할지

---

## 11. 결론

이 RFC는 "planner를 더 똑똑하게 만들자"는 문서가 아니다.

방향은 반대다.

- public search는 primitive/deterministic하게 단순화하고
- agent는 composition과 conversation에 집중시키며
- identity, fusion, rerank, similarity ranking truth는 search core에 남긴다

즉:

**search는 계산**

**agent는 조합**

이 경계를 명확히 하자는 RFC다.

따라서 이 RFC의 성격은:

- 최종 retrieval SOTA 설계 확정

이 아니라

- 그 SOTA work가 얹힐 수 있는 책임 경계 복원

이다.
