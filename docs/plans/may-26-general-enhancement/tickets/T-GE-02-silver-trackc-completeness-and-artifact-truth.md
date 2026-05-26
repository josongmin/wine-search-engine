# T-GE-02 Silver Track-C Completeness And Artifact Truth

## 목표

`silver-trackc.ndjson`가 실제로 full Track C artifact일 때만 그 이름을 갖도록 하고, completeness truth를 artifact 이름/validation/build gate에서 일치시킨다.

## 현재 근거

- Track C step definitions는 completeness를 강하게 요구한다: [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts#L50-L99)
- coverage assertion도 존재한다: [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts#L223-L240)
- local `data/silver-trackc.ndjson` 현실은 `criticProxy=0%`, `drinkingWindow=0%`, `producerPrestige=0%`, `gift=100%`, `beginner=100%`
- silver gate는 quality-critical coverage를 요구한다: [scripts/etl/validate-silver.ts](../../../../scripts/etl/validate-silver.ts#L188-L202)
- `validate-silver` live run은 fail했다.

## 선행 티켓

- [T-GE-01](./T-GE-01-vivino-payload-appellation-and-silver-contract-closure.md)

## 정확한 산출물

1. `trackc` artifact naming contract
2. partial Track C artifact를 위한 별도 artifact/state 정책
3. completeness rail 테스트
4. `validate-silver`와 `build-search-snapshot`가 같은 truth를 보도록 정리

## 구현 범위

1. Track C step별 completeness truth를 artifact metadata 또는 artifact path에서 구분한다.
2. `trackc`라는 canonical artifact는 full-enriched only로 제한한다.
3. partial artifact는 build/publish path에 못 들어가게 막는다.
4. `producerPrestige`가 Track C 필드가 아닌 base silver field라는 점을 별도 축으로 분리해 gate 메시지를 정리한다.

## 수정 대상 파일

- [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts)
- [scripts/etl/artifact-contract.ts](../../../../scripts/etl/artifact-contract.ts)
- [scripts/etl/validate-silver.ts](../../../../scripts/etl/validate-silver.ts)
- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts)
- [test/unit/etl/run-track-c.test.ts](../../../../test/unit/etl/run-track-c.test.ts)
- [test/unit/etl/validate-silver.test.ts](../../../../test/unit/etl/validate-silver.test.ts)

## 수정 금지 범위

- LTR release workflow 변경
- retrieval planner semantics 변경
- benchmark fixture catalog 변경

## 예상 충돌 파일

- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts#L237-L250)
- [scripts/etl/publish-search-snapshot.ts](../../../../scripts/etl/publish-search-snapshot.ts#L1187-L1263)

## 착수 전 확인

```bash
rg -n "trackc|requiredCoverage|allowPartialCoverage|quality gate|giftSuitability|beginnerSuitability|criticProxy|drinkingWindow" scripts/etl
pnpm exec tsx scripts/etl/validate-silver.ts --input data/silver-trackc.ndjson
```

## 구현 단계

1. canonical Track C artifact의 정의를 문서와 코드에 먼저 고정한다.
2. current artifact graph에서 partial artifact가 canonical path를 점유하는 seam을 찾는다.
3. artifact naming/state를 분리하거나 completeness marker를 추가한다.
4. `validate-silver`와 `build-search-snapshot`가 동일 기준으로 partial artifact를 거부하게 맞춘다.
5. local fixture를 사용한 unit/regression test로 닫는다.

## 작업 중단 조건

1. Track C 일부 step이 장기간 opt-in/disabled 상태라 full artifact contract를 당장 유지할 수 없음
2. current automation/scripts가 partial artifact naming에 강하게 의존해 한 PR로 못 닫음

## 롤백 기준

- `silver-trackc.ndjson`라는 이름은 유지되는데 partial completeness truth는 그대로인 경우
- build path는 막았지만 validate path는 여전히 partial artifact를 full로 취급하는 경우

## 금지사항

- fail artifact를 warning-only로 낮추지 말 것
- partial completeness를 report JSON만으로 숨기지 말 것
- artifact 이름과 실제 field coverage truth가 다른 상태를 남기지 말 것

## 수용 예시

- 수용:
  - partial artifact는 canonical build/publish path에 진입하지 못한다
- 비수용:
  - `trackc` 이름 그대로인데 critical fields 0% artifact도 downstream이 그대로 소비한다

## 테스트

- Track C artifact completeness contract test
- partial artifact rejection test
- silver gate parity test

## 검증 명령

```bash
pnpm vitest run test/unit/etl/run-track-c.test.ts test/unit/etl/validate-silver.test.ts test/unit/etl/build-search-snapshot.test.ts
pnpm exec tsx scripts/etl/validate-silver.ts --input data/silver-trackc.ndjson
```

## 머지 전 체크리스트

- [ ] canonical `trackc` artifact meaning이 단일함
- [ ] partial artifact가 build path에 못 들어감
- [ ] validate/build가 같은 completeness truth를 사용함

## DoD

1. `trackc` artifact 이름과 실제 completeness truth가 일치한다.
2. critical Track C field가 빠진 artifact는 canonical downstream에 진입하지 못한다.
3. `validate-silver` fail와 build gate fail의 기준이 서로 충돌하지 않는다.

## 완료 조건

- Track C artifact truth가 이름, gate, build path에서 모두 동일하다.
