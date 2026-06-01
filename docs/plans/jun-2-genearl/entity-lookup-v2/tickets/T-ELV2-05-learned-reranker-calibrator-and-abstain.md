# T-ELV2-05 Learned Reranker Calibrator And Abstain

## 목표

candidate union 위에 learned reranker와 calibrated abstain layer를 얹어 wrong-positive를 구조적으로 막는다.

## 정확한 산출물

1. candidate feature schema
2. learned scorer/reranker
3. calibrated confidence layer
4. class-aware abstain policy

## 반드시 건드릴 파일

1. `src/domain/resolver/**`
2. `src/application/search/**`
3. `scripts/eval/**`
4. `test/**`

## 구현 범위

1. feature extraction
2. scorer/reranker integration
3. calibration
4. `resolved | ambiguous | failed` decision boundary

## 금지사항

1. hot query hand-tuning만으로 품질을 맞추는 것
2. learned scorer 없이 threshold tweak만 반복하는 것

## DoD

1. `opu one`류 wrong-positive class가 calibrated abstain으로 닫힌다.
2. exact/high-evidence query recall은 유지된다.
