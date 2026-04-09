# Epic 17 — 실제 Confidence Calibration (AURC Claim 실현)

**Phase:** B (학습 점화) — **최대 임팩트 #3**
**우선순위:** P1
**의존:** Epic-13 (human-gated eval dataset)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `경량 피팅 필요`

---

## 현재 상태의 솔직한 진단

### "AURC-calibrated"는 거짓이다

코드 감사 결과:

- `confidence-refusal.ts`: threshold = **0.45 하드코딩**. 55줄 짜리 단일 비교.
- `threshold-profile.ts`: `computeDynamicGapThreshold()` = **switch문으로 query class별 상수 반환**
- Calibration 코드: **없음**
- Calibration 데이터: **없음**
- ROC curve / ECE 계산: **없음**
- 주석에 "refusal_rate >= 0.90 when C < threshold", "false_refusal_rate <= 0.05" — **검증 불가능한 claim**

`DEFAULT_THRESHOLD_PROFILE`의 7개 query class entry는 **수동 설정**이며, v1.0.0 → v2.1.0 evolution은 manual tuning iteration이지 systematic calibration이 아님.

### Decision engine 구조는 좋다

5-step pipeline (policy → numeric gate → evidence → overlay → admission)은 건전.
**threshold만 제대로 calibrate하면 됨.** 구조 변경 불필요.

---

## Task 목록

### T17-1. Calibration Dataset 구축 (Epic-13과 공유)

**현재:** 없음

**변경:**
- calibration은 `Epic-13`의 **human-reviewed gold split** 위에서 수행
- LLM-labeled judgments는 scale-out 보조로만 사용
- 최소: 200 queries × 10 classes = 2000 judgments
- 저장: `data/calibration/` + `pg_calibration_judgments` 테이블

---

### T17-2. 실제 AURC 계산 스크립트

**현재:** AURC 언급은 주석에만 존재

**변경:**
- `scripts/calibration/compute-aurc.ts`
- 입력: (confidence_score, gap_score, was_correct) per query
- 출력: AURC value, ROC curve, reliability diagram, optimal thresholds

**AURC (Area Under Risk-Coverage Curve) 계산:**
```
Risk(τ) = (wrong resolves at coverage τ) / (queries at coverage τ)
Coverage(τ) = (queries resolved at threshold τ) / (total queries)
AURC = ∫ Risk(coverage) d(coverage)
```

**Per-class 계산:** query class별로 별도 AURC curve

---

### T17-3. Per-Class Threshold Optimization

**현재:** 7개 class × 수동 상수

**변경:**
- 각 query class에서 AURC curve 계산
- Target: wrong_resolve_rate < 5% (RFC-007 §6.2의 utility: wrong resolve = -1.5)
- Per-class optimal (resolveTau, gapTau) = AURC curve에서 target을 만족하는 최소 threshold

**결과:** `data/calibration/threshold-profile-v3.0.0.json`
- `threshold-profile.ts`가 이 파일을 로드
- 수동 상수 제거

---

### T17-4. Confidence Calibration Model

**현재:** `confidence`는 raw weighted blend: `0.3×parser + 0.4×anchor + 0.3×constraint`

**문제:** 이 blend가 calibrated probability가 아님. 0.7이 "70% 확률로 올바른 결과"를 의미하지 않음.

**변경:**
- baseline: Platt scaling
- data가 충분한 class에서는 isotonic regression도 비교
- best calibrator는 ECE/Brier/AURC로 선택
- per-class calibrator 저장

**학계 근거:**
- Platt (1999) "Probabilistic Outputs for SVMs"
- Guo et al. (2017) "On Calibration of Modern Neural Networks" — temperature scaling

---

### T17-5. Conformal Prediction 활성화

**현재:** `conformalSetSize` 코드 존재하지만 calibration data 미공급

**변경:**
- Calibration set에서 nonconformity scores 계산
- 런타임: conformal set size = coverage guarantee를 만족하는 후보 수
- `conformalSetSize >= 2` → `ambiguous` (이미 decision engine에 구현됨)
- 이것은 **data만 공급하면 즉시 동작하는 인프라**

---

### T17-6. Calibration Monitoring + Recalibration

**변경:**
- ECE (Expected Calibration Error) 주간 계산
- Reliability diagram 자동 생성
- ECE > 0.1 → alert + recalibration trigger
- Monthly recalibration batch job

**학계 근거:**
- Naeini et al. (2015) "Obtaining Well Calibrated Probabilities Using Bayesian Binning"
- Adaptive Conformal Prediction (Gibbs & Candès, 2021) — online recalibration

---

## 완료 조건

- `scripts/calibration/compute-aurc.ts` 동작 + per-class AURC 수치 산출
- Per-class threshold가 AURC-optimal (수동 상수 제거)
- calibrator가 human gold split에서 ECE 개선
- Conformal prediction 동작 (data 공급)
- "AURC-calibrated" 주석이 **실제로 참**이 됨
