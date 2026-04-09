# Epic 08 — 운영·보안 → 안전한 실험 기반

**Phase:** A (기반 정리) — **P0 즉시**
**우선순위:** P0
**Breaking:** Minimal
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

보안 구멍이 있는 상태에서 A/B 실험, 학습 파이프라인을 구축하면 **공격 표면이 확대**된다.
- `/metrics/agent` 무인증 → 모델 성능 정보 유출
- Cyrillic injection → LLM prompt poisoning → 학습 데이터 오염 가능
- ReDoS → DoS 공격으로 eval pipeline 마비

**SOTA:** Security-first. 실험 인프라 구축 전 attack surface 최소화.

---

## Task 목록

### T08-1. `/metrics/agent` 인증 강화

시크릿 미설정 → 403. **즉시.**

### T08-2. `EVAL_RUN_AT_STARTUP` 분리

production 기본 false. 별도 CLI/cron.

### T08-3. CORS 주석 정합

주석 = 코드.

### T08-4. ReDoS 방어

`query-sanitizer.ts:175` `[\s\S]*?` → 길이 제한.

### T08-5. Cyrillic Injection 잔여 검증

ssot-audit #4-5 완료 상태 확인 + 추가 누락 스캔.

### T08-6. LLM Phrase Injection 방어

`llm-nl-mapper.ts:322` phrase validation + prompt hardening.
**SOTA 얼라인:** LLM을 사용하는 모든 경로에 input sanitization 필수.

### T08-7. SDK Error 도메인 누출 방지

`anthropic-llm-injection-classifier.ts:134` raw error wrapping.

---

## 완료 조건

- `/metrics/agent` 시크릿 미설정 → 403
- ReDoS 방어 테스트 통과
- LLM 입력 경로에 sanitization 존재
