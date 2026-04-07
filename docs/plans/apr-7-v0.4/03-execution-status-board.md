# 03. Execution Status Board

이 문서는 `apr-7-v0.4` execution unit의 **실행 상태판**이다.  
워커들은 이 문서를 기준으로 현재 상태를 갱신한다.

- 실행 순서 / DAG SSOT: [01-epic-task-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/01-epic-task-backlog.md)
- unit 작업 경계 / handoff spec: [02-execution-unit-cards.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/02-execution-unit-cards.md)

## 상태값

- `대기`
- `진행중`
- `완료`

## 업데이트 규칙

1. 상태를 바꿀 때는 `상태변경시각`을 반드시 같이 갱신한다
2. 시간 형식은 `YYYY-MM-DD HH:mm KST`로 고정한다
3. `진행중`은 같은 시점에 워커 1명만 가질 수 있다
4. `Blocked by`는 직접 선행 unit만 적는다
5. `Next`는 unit이 `완료`될 때만 채우고, `Primary unlocks` 중 즉시 착수 가능한 1개만 적는다
6. `closure` marker는 상태값이 아니라 종료 신호이므로 이 표의 `Next`에는 넣지 않는다

## Epic 1

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E1-U1` | `완료` | `2026-04-07 09:00 KST` | `Claude` | `-` | `E1-U2` |
| `E1-U2` | `완료` | `2026-04-07 10:00 KST` | `Claude` | `E1-U1` | `E1-U3` |
| `E1-U3` | `완료` | `2026-04-07 10:15 KST` | `Claude` | `E1-U2` | `E1-U4` |
| `E1-U4` | `완료` | `2026-04-07 10:30 KST` | `Claude` | `E1-U1` | `-` |
| `E1-U5` | `완료` | `2026-04-07 10:15 KST` | `Claude` | `E1-U2` | `E1-U6` |
| `E1-U6` | `완료` | `2026-04-07 10:45 KST` | `Claude` | `E1-U5` | `-` |
| `E1-U7` | `완료` | `2026-04-07 10:45 KST` | `Claude` | `E1-U5` | `-` |
| `E1-U8` | `완료` | `2026-04-07 10:45 KST` | `Claude` | `E1-U5` | `-` |
| `E1-U9` | `완료` | `2026-04-07 10:15 KST` | `Claude` | `E1-U2` | `-` |

## Epic 2

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E2-U1` | `완료` | `2026-04-07 11:00 KST` | `Claude` | `E1-U5` | `E2-U2` |
| `E2-U2` | `완료` | `2026-04-07 11:15 KST` | `Claude` | `E2-U1` | `E2-U3` |
| `E2-U3` | `완료` | `2026-04-07 11:30 KST` | `Claude` | `E2-U2` | `E2-U4` |
| `E2-U4` | `완료` | `2026-04-07 11:45 KST` | `Claude` | `E2-U3` | `E3-U1` |
| `E2-U5` | `완료` | `2026-04-07 11:45 KST` | `Claude` | `E2-U4` | `-` |
| `E2-U6` | `완료` | `2026-04-07 11:45 KST` | `Claude` | `E2-U4` | `-` |
| `E2-U7` | `완료` | `2026-04-07 11:45 KST` | `Claude` | `E2-U4` | `-` |

## Epic 3

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E3-U1` | `완료` | `2026-04-07 12:00 KST` | `Claude` | `E2-U4` | `E3-U2` |
| `E3-U2` | `완료` | `2026-04-07 12:15 KST` | `Claude` | `E3-U1` | `E3-U3` |
| `E3-U3` | `완료` | `2026-04-07 12:15 KST` | `Claude` | `E3-U2` | `E3-U4` |
| `E3-U4` | `완료` | `2026-04-07 12:15 KST` | `Claude` | `E3-U2` | `E3-U5` |
| `E3-U5` | `완료` | `2026-04-07 12:30 KST` | `Claude` | `E3-U1` | `E3-U6` |
| `E3-U6` | `완료` | `2026-04-07 12:30 KST` | `Claude` | `E3-U3`, `E3-U5` | `E3-U7` |
| `E3-U7` | `완료` | `2026-04-07 12:30 KST` | `Claude` | `E3-U6` | `E4-U6` |

## Epic 4

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E4-U1` | `완료` | `2026-04-07 13:00 KST` | `Claude` | `E1-U6` | `E4-U2` |
| `E4-U2` | `완료` | `2026-04-07 13:00 KST` | `Claude` | `E4-U1` | `-` |
| `E4-U3` | `완료` | `2026-04-07 13:00 KST` | `Claude` | `E4-U1` | `-` |
| `E4-U4` | `완료` | `2026-04-07 13:15 KST` | `Claude` | `E4-U1` | `E4-U5` |
| `E4-U5` | `완료` | `2026-04-07 13:15 KST` | `Claude` | `E4-U4` | `E4-U7` |
| `E4-U6` | `완료` | `2026-04-07 13:15 KST` | `Claude` | `E4-U1`, `E3-U7` | `E4-U7` |
| `E4-U7` | `완료` | `2026-04-07 13:15 KST` | `Claude` | `E4-U5`, `E4-U6` | `E5-U1` |

## Epic 5

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E5-U1` | `완료` | `2026-04-07 14:00 KST` | `Claude` | `E1-U8`, `E3-U5` | `E5-U2` |
| `E5-U2` | `완료` | `2026-04-07 14:15 KST` | `Claude` | `E5-U1` | `E5-U3` |
| `E5-U3` | `완료` | `2026-04-07 14:30 KST` | `Claude` | `E5-U2` | `E5-U4` |
| `E5-U4` | `완료` | `2026-04-07 14:45 KST` | `Claude` | `E5-U3` | `E5-U6` |
| `E5-U5` | `완료` | `2026-04-07 14:45 KST` | `Claude` | `E5-U2`, `E3-U7` | `E5-U6` |
| `E5-U6` | `완료` | `2026-04-07 15:00 KST` | `Claude` | `E5-U3`, `E5-U4`, `E5-U5` | `E5-U7` |
| `E5-U7` | `완료` | `2026-04-07 15:00 KST` | `Claude` | `E5-U3`, `E5-U6` | `E6-U1` |

## Epic 6

| Unit | Status | 상태변경시각 | Worker | Blocked by | Next |
| --- | --- | --- | --- | --- | --- |
| `E6-U1` | `완료` | `2026-04-07 15:30 KST` | `Claude` | `E5-U7` | `E6-U2` |
| `E6-U2` | `완료` | `2026-04-07 15:30 KST` | `Claude` | `E6-U1` | `-` |
| `E6-U3` | `완료` | `2026-04-07 15:30 KST` | `Claude` | `E6-U1` | `-` |
| `E6-U4` | `완료` | `2026-04-07 15:30 KST` | `Claude` | `E6-U1` | `-` |
| `E6-U5` | `완료` | `2026-04-07 15:30 KST` | `Claude` | `E6-U1` | `-` |

## 운영 메모

- `Blocked by`가 둘 이상이면, 모두 `완료`되기 전까지 상태는 `대기`다
- `Next`가 `-`인 unit은 아직 handoff 시점이 아니거나, task closure / downstream epic consumer만 남은 경우다
- 초기 템플릿에서는 `Next`를 비워 두고, 실제 `완료` 시점에만 즉시 착수 가능한 1개를 채운다
- 상태 갱신은 worker가 끝에 몰아서 하지 말고, `진행중` 진입 시점과 `완료` 시점 두 번 반드시 남긴다
