# T-E10-04 Replay Triage Playbook And Ops Doc Linkage

## 목표

debug-mode 플레이북과 운영 문서에 replay triage 절차를 연결해, golden trace 실패 시 작업자가 즉시 대응할 수 있게 만든다.

## 현재 근거

- EPIC-10은 debug-mode 플레이북과 운영 문서에 replay triage 절차 연결을 요구한다: [EPIC-10-replay-observability-golden-set.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-10-replay-observability-golden-set.md:31>)
- 현재 tasks는 기술 구현 쪽은 다루지만 운영 플레이북 linkage 전용 티켓은 없다.

## 선행 티켓

- [T-E10-03 release-eval-golden-trace-contract-gate](./T-E10-03-release-eval-golden-trace-contract-gate.md) 권장

## 정확한 산출물

1. replay triage playbook 문서 업데이트
2. debug-mode 문서와 bugbash 문서 간 링크
3. 운영자용 triage 절차 예시

## 구현 범위

1. replay/golden failure를 triage하는 절차를 문서화한다.
2. debug-mode 플레이북, bugbash epic/task, 운영 문서를 상호 링크한다.
3. 대표 failure 예시 2개 이상을 문서에 추가한다.

## 수정 대상 파일

- [/.ai/llm-debugging-playbook.md](</Users/songmin/Documents/code-wine/wine-search-engine/.ai/llm-debugging-playbook.md:1>)
- [/.ai/debug-mode.md](</Users/songmin/Documents/code-wine/wine-search-engine/.ai/debug-mode.md:1>)
- bugbash EPIC-10 / tasks docs

## 수정 금지 범위

- runtime search logic 변경
- replay harness 코드 변경
- release gate policy 변경

## 예상 충돌 파일

- [/.ai/llm-debugging-playbook.md](</Users/songmin/Documents/code-wine/wine-search-engine/.ai/llm-debugging-playbook.md:1>)
- [/.ai/debug-mode.md](</Users/songmin/Documents/code-wine/wine-search-engine/.ai/debug-mode.md:1>)
- EPIC-10 docs

## 착수 전 확인

```bash
rg -n "replay|golden|trace|triage|debug mode" .ai docs/bugbash/apr-14-pipeline-retrival
```

## 구현 단계

1. 현재 triage 흐름을 문서에서 찾는다.
2. replay/golden trace failure 대응 절차를 추가한다.
3. debug-mode 문서와 bugbash 문서를 상호 링크한다.
4. 예시 failure 두 건을 넣는다.

## 작업 중단 조건

1. 운영 문서 위치/소유권이 이 repo 밖에 있어 링크만으로는 닫을 수 없음
2. replay triage 절차가 아직 기술적으로 안정화되지 않음

## 롤백 기준

- 링크만 추가하고 절차 본문이 없는 경우
- example 없이 추상 지침만 추가하는 경우

## 금지사항

- "로그를 잘 본다" 수준의 추상 문구 금지
- bugbash 문서와 디버깅 문서가 서로 다른 절차를 설명하게 두지 말 것

## 수용 예시

- 수용:
  - "golden trace parity 실패 -> replay fixture 재실행 -> execution/provenance_trace diff 확인 -> stage timeline 확인"
- 비수용:
  - "실패 시 담당자에게 문의"

## 테스트

- 문서 티켓이다. 링크 무결성과 절차 완결성을 리뷰 기준으로 본다.

## 검증 명령

```bash
rg -n "golden trace|replay triage|execution_trace|provenance_trace" .ai docs/bugbash/apr-14-pipeline-retrival
```

## 머지 전 체크리스트

- [ ] debug-mode 문서와 bugbash 문서가 연결됨
- [ ] triage 절차가 단계별로 적힘
- [ ] example failure 두 건 이상 존재

## 완료 조건

- golden trace 실패 시 새 작업자가 문서만 보고 triage를 시작할 수 있다.
