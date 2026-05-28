# May 28 CLI Tickets

> 목적: [../rfc.md](../rfc.md)와 [../architecture-decision.md](../architecture-decision.md)를 실행 티켓으로 분해한다.

## 필수 읽기

1. [../rfc.md](../rfc.md)
2. [../architecture-decision.md](../architecture-decision.md)
3. [../../../CLAUDE.md](../../../CLAUDE.md)

## 작업 시작 규칙

1. 작업자는 먼저 자신이 건드릴 티켓의 `정확한 산출물`, `수정 금지 범위`, `검증 명령`을 읽는다.
2. 파일 추가 위치가 architecture 문서와 다르면 먼저 문서를 수정하거나 예외 사유를 남긴다.
3. 티켓 구현 중 command/kernel shape를 바꿔야 하면 `T-CLI-01` 또는 `architecture-decision`을 먼저 업데이트한다.

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-CLI-01` | command kernel / runtime targets | done | 없음 | shell, registry, context, target resolver |
| `T-CLI-02` | auth / profile plane | done | `T-CLI-01` | auth command, doctor, profile precedence |
| `T-CLI-03` | typed search / entity / wine-search commands | done | `T-CLI-01`, `T-CLI-02` | typed facades + local/remote adapters |
| `T-CLI-04` | raw API call / output contract | done | `T-CLI-01`, `T-CLI-02` | raw invoker + renderer contract |
| `T-CLI-05` | package / completion / proof rails | done | `T-CLI-03`, `T-CLI-04` | package/bin/help/smoke rail |

## Wave

### Wave 1

- [T-CLI-01](./T-CLI-01-command-kernel-and-runtime-targets.md)

### Wave 2

- [T-CLI-02](./T-CLI-02-auth-and-profile-plane.md)

### Wave 3

- [T-CLI-03](./T-CLI-03-typed-search-and-entity-commands.md)
- [T-CLI-04](./T-CLI-04-raw-api-call-and-output-contract.md)

### Wave 4

- [T-CLI-05](./T-CLI-05-packaging-completion-and-proof-rails.md)

## 병렬성 규칙

1. `T-CLI-01`이 command kernel과 target abstraction을 닫기 전에는 나머지 티켓 구현 금지
2. `T-CLI-03`과 `T-CLI-04`는 `T-CLI-02` 이후 병렬 가능
3. `T-CLI-05`는 `typed command`와 `raw API` shape가 둘 다 닫힌 뒤 진행

## 작업 분배 가이드

### 작업자 A

- `T-CLI-01`
- `T-CLI-05`

### 작업자 B

- `T-CLI-02`

### 작업자 C

- `T-CLI-03`

### 작업자 D

- `T-CLI-04`

병렬 투입 시 A가 kernel을 닫기 전까지 B/C/D는 코드 구현이 아니라 draft branch만 준비해야 한다.

## 공통 금지사항

1. local mode에서 Fastify self-call 금지
2. `scripts/*.ts` monolith CLI 금지
3. command 내부 direct `fetch`/`fs`/`child_process` 호출 금지
4. route handler 재사용 금지
5. typed command와 raw API command contract 혼합 금지
6. shell이 leaf command business logic을 품는 구조 금지

## 작업자 체크리스트

착수 전:

1. 선행 티켓 상태 확인
2. architecture-decision의 파일 위치와 책임 확인
3. 추가할 파일이 ticket 범위 안에 있는지 확인

구현 중:

1. 새 타입이 shell/application/infrastructure 중 어디 소속인지 확인
2. direct `process.exit()`가 shell 외에 없는지 확인
3. output이 renderer를 통해서만 나가는지 확인

완료 전:

1. 티켓 문서의 검증 명령 실행
2. 금지사항 위반 없는지 grep 확인
3. closeout note에 남은 리스크 기록

## 티켓 목록

- [T-CLI-01 Command Kernel And Runtime Targets](./T-CLI-01-command-kernel-and-runtime-targets.md)
- [T-CLI-02 Auth And Profile Plane](./T-CLI-02-auth-and-profile-plane.md)
- [T-CLI-03 Typed Search And Entity Commands](./T-CLI-03-typed-search-and-entity-commands.md)
- [T-CLI-04 Raw API Call And Output Contract](./T-CLI-04-raw-api-call-and-output-contract.md)
- [T-CLI-05 Packaging Completion And Proof Rails](./T-CLI-05-packaging-completion-and-proof-rails.md)
