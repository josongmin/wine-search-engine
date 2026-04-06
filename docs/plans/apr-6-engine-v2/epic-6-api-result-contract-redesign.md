# Epic 6: API / Result Contract Redesign

**성격:** should  
**목표:** human search와 machine/LLM consumption을 구분하는 결과 계약을 설계한다.  
**의존성:** Epic 5

---

## 왜 필요한가

현재 [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)는 풍부하지만, 사람에게 보여줄 카드 결과와 LLM/tool이 소비할 evidence-rich envelope가 같은 계약 안에 섞여 있다.

브레이킹 체인지 허용이라면 이 레이어를 깔끔하게 분리할 수 있다.

---

## 목표 상태

- public human search response
- machine/LLM retrieval envelope
- interpret/debug/explain response

이 세 계약의 목적을 분리한다.

---

## 레포에서 건드리는 축

- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)
- [src/interface/http/routes](/Users/songmin/wine-search-engine/src/interface/http/routes)

---

## In Scope

- result contract family 정의
- human vs machine response 구분
- explain / interpret 응답 정리
- OpenAPI and route contract migration

## Out Of Scope

- retrieval/ranking core algorithm 변경
- Vespa projection redesign

---

## 핵심 작업

### Step 1. Result contract family 정의

- `SearchResponseV2Human`
- `SearchResponseV2Machine`
- `InterpretResponseV2`

처럼 명시적으로 목적을 나눈다.

### Step 2. Evidence / provenance surfacing 정책 정의

human response엔 요약된 evidence, machine response엔 structured provenance를 준다.

### Step 3. Route surface 재배치

기존 경로를 그대로 버전업할지, 새 route family를 열지 결정한다.

### Step 4. OpenAPI parity 재정렬

새 result family가 OpenAPI와 테스트에 일관되게 반영되게 한다.

### Step 5. Migration story 문서화

기존 route를 유지할지, versioned route를 열지, field-level deprecation을 둘지 명시한다.

---

## 설계 원칙

1. 내부 retrieval envelope를 그대로 public UX response로 노출하지 않는다.
2. explain/debug 목적 응답은 search UX 응답과 분리한다.
3. schema는 runtime code와 parity를 유지한다.
4. 브레이킹 허용이더라도 migration story는 문서화한다.

---

## 완료 기준

- human vs machine result contract가 분리된다.
- evidence/provenance 노출 정책이 계약에 명시된다.
- OpenAPI와 route contracts가 새 응답 표면을 정확히 반영한다.
- 기존 `SearchResponseSchema`의 다목적 과부하가 해소된다.

## 검증 전략

- route contract tests
- OpenAPI parity tests
- response schema validation tests
- e2e contract suite
