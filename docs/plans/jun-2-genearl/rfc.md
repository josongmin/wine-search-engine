# Jun 2 General RFC — Entity Lookup Hardening And Operator Tooling

> 목적: `/v1/lookup/wine`를 운영형 entity lookup으로 끌어올리기 위해 `admission`, `abstain`, `alias substrate`, `trusted ops tooling`을 한 묶음으로 재구성한다.
>
> Historical / audit-only document.
> Current public lookup truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> `/v1/lookup/wine` references below preserve the pre-cutover hardening plan,
> not the current route contract.

---

## 1. 문제 정의

현재 entity lookup은 큰 구조는 맞지만, 운영형 품질/운영성 기준으로는 아래 결손이 남아 있다.

1. lookup endpoint에 들어온 질의를 거의 그대로 entity lane으로 강제한다.
2. short noisy typo에서 wrong-positive를 fail-close하지 못한다.
3. top entity alias substrate에 catalog hole이 있다.
4. concept/facet query와 entity query의 front-door contract가 약하다.
5. operator가 alias/resolver decision을 한 번에 해부할 trusted tooling이 없다.
6. proposal/ambiguity/suppression 관리가 JSONL/psql/manual publish에 묶여 있다.

이 RFC는 위 6개 축을 `lookup core`, `alias governance`, `ops read plane`, `ops write plane`, `proof rail`로 분해한다.

---

## 2. 현재 근거

- `/v1/lookup/wine`는 path authority로 `lookup_wine` primitive를 강제한다:
  - [src/interface/http/routes/primitive-search.route.ts](../../../src/interface/http/routes/primitive-search.route.ts#L126-L156)
  - [src/interface/http/routes/search-request-mappers.ts](../../../src/interface/http/routes/search-request-mappers.ts#L63-L84)
- lookup path는 planner를 우회해 entity lookup primitive plan으로 바로 간다:
  - [src/application/search/search-usecase-pre-route-phase.ts](../../../src/application/search/search-usecase-pre-route-phase.ts#L633-L667)
- anchor refresh safety net은 있다:
  - [src/application/search/search-usecase-pre-route-phase.ts](../../../src/application/search/search-usecase-pre-route-phase.ts#L438-L495)
  - [src/domain/query/service/anchor-refresh.ts](../../../src/domain/query/service/anchor-refresh.ts)
- entity execution은 `blocker -> hydrate -> resolver -> corrective retry` spine을 가진다:
  - [src/application/search/search.usecase.ts](../../../src/application/search/search.usecase.ts#L573-L692)
- resolver/scorer는 already-rich signals를 갖고 있다:
  - [src/domain/resolver/service/resolver.ts](../../../src/domain/resolver/service/resolver.ts)
  - [src/domain/resolver/service/candidate-scorer.ts](../../../src/domain/resolver/service/candidate-scorer.ts)
  - [src/domain/resolver/service/resolver-lookup-strategy.ts](../../../src/domain/resolver/service/resolver-lookup-strategy.ts)
- alias substrate generation/publish path는 이미 존재한다:
  - [scripts/etl/generate-aliases.ts](../../../scripts/etl/generate-aliases.ts)
  - [scripts/etl/generate-korean-aliases.ts](../../../scripts/etl/generate-korean-aliases.ts)
  - [scripts/etl/generate-transliteration-aliases.ts](../../../scripts/etl/generate-transliteration-aliases.ts)
  - [scripts/etl/publish-runtime-substrates.ts](../../../scripts/etl/publish-runtime-substrates.ts)
- runtime-plane writer authority는 publisher 하나로 봉인돼 있다:
  - [test/regression/runtime-plane-insert-authority.regression.test.ts](../../../test/regression/runtime-plane-insert-authority.regression.test.ts)
- internal resolve route는 있으나 operator-grade debug contract는 아니다:
  - [src/interface/http/routes/resolve.route.ts](../../../src/interface/http/routes/resolve.route.ts)
- live failures:
  - `opu one -> Alma Fria Pinot Noir` wrong-positive
  - `dom perignon`, `돔페리뇽` lookup 0건
  - `까쇼`가 single wine entity로 over-resolve

---

## 3. 목표

1. `/v1/lookup/wine`가 `entity lookup only` contract를 front-door에서 강제한다.
2. short/noisy/entity-ambiguous query는 `resolved`보다 `ambiguous/failed`를 우선하는 fail-close policy를 가진다.
3. top traffic entity alias substrate와 transliteration coverage를 운영 가능한 형태로 관리한다.
4. operator가 `surface -> alias hits -> candidates -> scores -> final decision`을 trusted tooling으로 즉시 확인할 수 있다.
5. alias proposal / ambiguity / suppression write plane이 runtime-plane direct write 없이 staging/publish 흐름으로 관리된다.
6. hot-entity regression과 operator smoke가 지속적으로 품질 드리프트를 막는다.

---

## 4. 비범위

- public product search를 agentic orchestration으로 재설계
- runtime-plane direct writer를 publisher 외 코드로 추가
- Vespa schema 전면 교체
- 전체 benchmark framework 재작성
- UI cosmetic refresh

---

## 5. 설계 원칙

1. `lookup endpoint`에 들어왔다는 사실만으로 entity resolve를 강제하지 않는다.
2. wrong-positive는 no-result보다 더 나쁜 실패로 취급한다.
3. concept/facet shorthand는 lookup에서 resolve하지 말고 discovery로 redirect 또는 fail-close한다.
4. runtime `aliases` / `ambiguity_registry` direct write는 금지한다. staging/proposal -> publish만 허용한다.
5. operator tooling은 public product contract와 분리된 trusted surface여야 한다.
6. debug/audit는 public search response의 optional trace field에 기대지 않고 explicit contract를 가진다.
7. hot entity alias는 curated substrate를 허용한다. 다만 provenance와 approval state를 남겨야 한다.

---

## 6. Target Spine

### 6.1 Read path

`lookup admission -> alias/candidate generation -> calibrated resolver -> abstain/clarify/fail -> response`

### 6.2 Write / curation path

`proposal generation -> human/operator review -> staging tables -> snapshot build/publish -> runtime substrate`

### 6.3 Trusted operator path

`ops API (read-only debug/audit) -> web ops console -> optional write-plane UI -> publish`

---

## 7. Wave 순서

### Wave 1 — lookup core hardening

- `T-EL-01` lookup admission gate and query-family authority
- `T-EL-02` resolver abstain and short-noisy fail-close
- `T-EL-03` alias substrate governance and hot-entity coverage

### Wave 2 — trusted read plane

- `T-EL-04` operator debug API and runtime observability

### Wave 3 — web operator tooling

- `T-EL-05` ops web console for lookup/alias debug
- `T-EL-06` curation write plane for proposals, ambiguity, suppression

### Wave 4 — proof / gate

- `T-EL-07` proof rails, hotset eval, operator smoke

### 순서 이유

1. admission/abstain policy 없이 ops 툴을 먼저 만들면 tool이 unstable semantics를 그대로 노출한다.
2. alias substrate governance 없이 web curation을 먼저 만들면 hole을 UI로만 덮게 된다.
3. write-plane은 runtime-plane writer invariant를 지켜야 하므로 read-plane contract가 먼저 고정되어야 한다.
4. proof rail은 최종 surface와 staging/publish semantics가 닫힌 뒤에만 의미가 있다.

---

## 8. 전역 DoD

1. `/v1/lookup/wine`가 concept query를 entity resolve하지 않는다.
2. short noisy typo wrong-positive class가 regression hotset에서 fail-close로 전환된다.
3. top entity alias hole audit가 operator-visible artifact로 남는다.
4. `lookup-debug`, `alias-audit`, `snapshot-alias-health` trusted surface가 존재한다.
5. proposal/ambiguity/suppression이 JSONL/psql 수작업만으로 운영되지 않는다.
6. runtime-plane insert authority regression이 계속 green이다.
7. hotset/noisy entity eval이 operator smoke와 함께 closeout gate로 동작한다.

---

## 9. 전역 검증 명령

```bash
pnpm run typecheck
pnpm run typecheck:etl
pnpm run test:verification:noisy
pnpm run test:integration:file -- test/integration/http/routes/primitive-search.route.test.ts
pnpm vitest run src/domain/resolver/service/__tests__/*.test.ts src/infrastructure/adapter/__tests__/pg-alias-matcher.test.ts src/infrastructure/adapter/__tests__/search-index-alias-matcher.test.ts
pnpm vitest run test/regression/runtime-plane-insert-authority.regression.test.ts test/regression/pg-alias-repository-readonly-surface.regression.test.ts
pnpm exec tsx scripts/etl/verify-search-snapshot-readiness.ts --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --require-pointer-parity
```

---

## 10. 티켓 목록

- [tickets/README.md](./tickets/README.md)
- [T-EL-01 Lookup Admission Gate And Query-Family Authority](./tickets/T-EL-01-lookup-admission-gate-and-query-family-authority.md)
- [T-EL-02 Resolver Abstain And Short-Noisy Fail-Close](./tickets/T-EL-02-resolver-abstain-and-short-noisy-fail-close.md)
- [T-EL-03 Alias Substrate Governance And Hot-Entity Coverage](./tickets/T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)
- [T-EL-04 Operator Debug API And Runtime Observability](./tickets/T-EL-04-operator-debug-api-and-runtime-observability.md)
- [T-EL-05 Ops Web Console For Lookup And Alias Debug](./tickets/T-EL-05-ops-web-console-for-lookup-and-alias-debug.md)
- [T-EL-06 Curation Write Plane For Proposals Ambiguity And Suppression](./tickets/T-EL-06-curation-write-plane-for-proposals-ambiguity-and-suppression.md)
- [T-EL-07 Proof Rails Hotset Eval And Operator Smoke](./tickets/T-EL-07-proof-rails-hotset-eval-and-operator-smoke.md)
