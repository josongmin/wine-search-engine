# May 26 General Enhancement Tickets

> 목적: `docs/plans/may-26-general-enhancement/rfc.md`를 티켓 단위 구현 보드로 분해한다.

## 필수 읽기

1. [../rfc.md](../rfc.md)
2. [../../../bugbash/apr-14-pipeline-retrival/tasks/TICKET-QUALITY-GATE.md](../../../bugbash/apr-14-pipeline-retrival/tasks/TICKET-QUALITY-GATE.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 |
|---|---|---|---|
| `T-GE-01` | Vivino payload / silver contract / appellation | open | 없음 |
| `T-GE-02` | Track C completeness / artifact truth | open | `T-GE-01` |
| `T-GE-03` | text substrate / region normalization parity | open | `T-GE-01` |
| `T-GE-06` | ingestion heuristic purge / provenance truth | open | `T-GE-02`, `T-GE-03` |
| `T-GE-04` | snapshot publish quality gates / LTR closure | open | `T-GE-02`, `T-GE-03`, `T-GE-06` |
| `T-GE-05` | retrieval semantics / analyzer-planner tier SSOT | open | `T-GE-04`, `T-GE-06` |

## Wave

### Wave 1

- [T-GE-01](./T-GE-01-vivino-payload-appellation-and-silver-contract-closure.md)
- [T-GE-02](./T-GE-02-silver-trackc-completeness-and-artifact-truth.md)
- [T-GE-03](./T-GE-03-search-text-and-region-normalization-parity.md)

### Wave 2

- [T-GE-06](./T-GE-06-ingestion-heuristic-purge-and-provenance-truth.md)

### Wave 3

- [T-GE-04](./T-GE-04-snapshot-publish-quality-gates-and-ltr-closure.md)

### Wave 4

- [T-GE-05](./T-GE-05-retrieval-constraint-semantics-and-tier-ssot.md)

## 병렬성 규칙

1. `T-GE-02`와 `T-GE-03`은 `T-GE-01` 이후 병렬 가능
2. `T-GE-06`은 `T-GE-02`와 `T-GE-03` 이후 진행
3. `T-GE-04`는 `T-GE-02`, `T-GE-03`, `T-GE-06`이 닫힌 뒤 진행
4. `T-GE-05`는 코드 작업 자체는 일부 병렬 가능하지만, 검증 closeout은 `T-GE-04`와 `T-GE-06` 이후만 허용

## 공통 금지사항

1. heuristic fallback 추가 금지
2. partial artifact를 full artifact처럼 rename 금지
3. quality degraded publish를 readiness green만으로 허용 금지
4. analyzer/planner mismatch를 attribute-name 재분류로만 덮는 임시 수정 금지

## 티켓 목록

- [T-GE-01 Vivino Payload Appellation And Silver Contract Closure](./T-GE-01-vivino-payload-appellation-and-silver-contract-closure.md)
- [T-GE-02 Silver Track-C Completeness And Artifact Truth](./T-GE-02-silver-trackc-completeness-and-artifact-truth.md)
- [T-GE-03 Search Text And Region Normalization Parity](./T-GE-03-search-text-and-region-normalization-parity.md)
- [T-GE-06 Ingestion Heuristic Purge And Provenance Truth](./T-GE-06-ingestion-heuristic-purge-and-provenance-truth.md)
- [T-GE-04 Snapshot Publish Quality Gates And LTR Closure](./T-GE-04-snapshot-publish-quality-gates-and-ltr-closure.md)
- [T-GE-05 Retrieval Constraint Semantics And Tier SSOT](./T-GE-05-retrieval-constraint-semantics-and-tier-ssot.md)
