# Entity Lookup V2 Tickets

> 목적: [../rfc.md](../rfc.md)를 breaking-change 허용 lookup V2 리팩토링 작업 티켓으로 분해한다.

## 필수 읽기

1. [../rfc.md](../rfc.md)
2. [../../rfc.md](../../rfc.md)
3. [../../tickets/T-EL-01-lookup-admission-gate-and-query-family-authority.md](../../tickets/T-EL-01-lookup-admission-gate-and-query-family-authority.md)
4. [../../tickets/T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md](../../tickets/T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)
5. [../../../../AGENTS.md](../../../../AGENTS.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-ELV2-01` | dedicated lookup contract | shipped | 없음 | `/v2/entity-lookup` contract |
| `T-ELV2-02` | admission / normalization / concept gate | shipped | `T-ELV2-01` | front-door query classifier |
| `T-ELV2-03` | alias registry v2 / curation substrate | partial | 없음 | dedicated lookup alias plane |
| `T-ELV2-04` | multi-channel candidate retrieval runtime | partial | `T-ELV2-01`, `T-ELV2-02`, `T-ELV2-03` | candidate union engine |
| `T-ELV2-05` | learned reranker / calibrator / abstain | partial | `T-ELV2-04` | final decision layer |
| `T-ELV2-06` | family graph / ambiguity graph | partial | `T-ELV2-03`, `T-ELV2-04` | clarification-capable graph substrate |
| `T-ELV2-07` | trusted operator plane / curation write plane | shipped | `T-ELV2-03`, `T-ELV2-05`, `T-ELV2-06` | ops UI/API |
| `T-ELV2-08` | hotset eval / shadow compare / cutover | partial | 전부 | V2 proof, cutover shipped, live canary and legacy purge closeout |

## Wave

### Wave 1

- [T-ELV2-01](./T-ELV2-01-dedicated-lookup-contract-and-public-surface-split.md)
- [T-ELV2-02](./T-ELV2-02-admission-normalization-and-concept-gate.md)
- [T-ELV2-03](./T-ELV2-03-alias-registry-v2-and-curation-substrate.md)

### Wave 2

- [T-ELV2-04](./T-ELV2-04-multi-channel-candidate-retrieval-runtime.md)
- [T-ELV2-05](./T-ELV2-05-learned-reranker-calibrator-and-abstain.md)
- [T-ELV2-06](./T-ELV2-06-family-graph-and-ambiguity-graph.md)

### Wave 3

- [T-ELV2-07](./T-ELV2-07-trusted-operator-plane-and-curation-write-plane.md)

### Wave 4

- [T-ELV2-08](./T-ELV2-08-hotset-eval-shadow-compare-cutover-and-legacy-purge.md)

## 병렬성 규칙

1. `T-ELV2-01` 없이 나머지 티켓은 public authority가 없다.
2. `T-ELV2-03`은 `T-ELV2-01`과 병렬 가능하다. lookup substrate는 surface와 독립적으로 만들 수 있다.
3. `T-ELV2-04`는 contract/admission/substrate 셋이 있어야만 의미가 있다.
4. `T-ELV2-05`는 retrieval runtime 없이는 점수화/abstain을 설계할 수 없다.
5. `T-ELV2-06`은 graph substrate이므로 `T-ELV2-03`과 `T-ELV2-04` 이후만 한다.
6. `T-ELV2-07`은 read/write plane이므로 core semantics가 고정된 뒤에만 한다.
7. `T-ELV2-08`은 마지막 closeout 전용이다.

## 공통 금지사항

1. V2를 사실상 V1 wrapper로 만드는 것 금지
2. public V2 contract가 primitive search schema를 재사용하는 것 금지
3. runtime-plane direct writer를 publisher 외에 추가하는 것 금지
4. hot query 문자열 하드코딩으로 품질을 맞추는 것 금지
5. cutover 전에 shadow compare 없이 V1을 지우는 것 금지

## 공통 owning seam 규칙

1. contract/surface는 `src/interface/http/**`, `src/application/search/**` 안에서 닫는다.
2. substrate는 `scripts/etl/**`, `src/domain/alias/**`, `src/infrastructure/**` 안에서 닫는다.
3. retrieval runtime은 `src/domain/resolver/**`, `src/infrastructure/adapter/**`, `src/application/search/**` 안에서 닫는다.
4. ops plane은 `src/interface/http/**` + `web/**` 안에서 닫는다.
5. cutover/proof는 `scripts/eval/**`, `test/**`, `docs/**`에서 닫는다.

## 티켓 목록

- [T-ELV2-01 Dedicated Lookup Contract And Public Surface Split](./T-ELV2-01-dedicated-lookup-contract-and-public-surface-split.md)
- [T-ELV2-02 Admission Normalization And Concept Gate](./T-ELV2-02-admission-normalization-and-concept-gate.md)
- [T-ELV2-03 Alias Registry V2 And Curation Substrate](./T-ELV2-03-alias-registry-v2-and-curation-substrate.md)
- [T-ELV2-04 Multi-Channel Candidate Retrieval Runtime](./T-ELV2-04-multi-channel-candidate-retrieval-runtime.md)
- [T-ELV2-05 Learned Reranker Calibrator And Abstain](./T-ELV2-05-learned-reranker-calibrator-and-abstain.md)
- [T-ELV2-06 Family Graph And Ambiguity Graph](./T-ELV2-06-family-graph-and-ambiguity-graph.md)
- [T-ELV2-07 Trusted Operator Plane And Curation Write Plane](./T-ELV2-07-trusted-operator-plane-and-curation-write-plane.md)
- [T-ELV2-08 Hotset Eval Shadow Compare Cutover And Legacy Purge](./T-ELV2-08-hotset-eval-shadow-compare-cutover-and-legacy-purge.md)
