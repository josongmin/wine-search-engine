# Runbook — embedding recipe rollout (Wave 2 SOTA++)

레시피 파일: [`tools/embedding-recipe/embedding-recipe-v1.json`](../tools/embedding-recipe/embedding-recipe-v1.json)
로더: [`scripts/etl/embedding-recipe.ts`](../scripts/etl/embedding-recipe.ts)
사용 지점: [`scripts/etl/index-to-vespa.ts`](../scripts/etl/index-to-vespa.ts) `buildEmbedText()`

## 무엇이 바뀌었나

dense 임베딩 입력 문자열을 만드는 규칙(필드 목록·가중치·prefix·구분자·한글 alias 포함 여부·상한)을 코드에서 분리하여 JSON으로 외부화. ETL 시작 시 Zod로 검증되고, 잘못된 JSON / 누락 필드 / strict 모드 위반은 즉시 throw.

새로 임베딩에 포함되는 신호:

- `flavor_profiles`, `pairing_tags`, `sensory_summary` (`body=0.80 acidity=0.60 ...`) — 79~100% 점유율인데 그동안 dense 임베딩에 한 글자도 안 들어가던 신호
- 한글 alias 최대 10개 (`ko: 오푸스원 / 일레븐일레븐 ...`) — 한국어 쿼리가 alias 인덱스를 우회해도 의미 공간에서 가깝게 정렬되도록

## 캐시 무효화

`semantic_summary` 동일성으로 재사용 캐시가 동작합니다 (`preparePreparedVespaFeedDocuments`). 임베딩 텍스트 첫 토큰이 `recipe-v<version>`이므로 **JSON의 `version` 필드를 올리는 순간 코퍼스 전체가 cache miss → 재임베딩** 대상이 됩니다. 다음 사유가 있을 때만 bump:

- 필드 추가/삭제/순서 변경
- 가중치(`weight`) 변경
- `prefix`, `field_separator` 변경
- `include_korean_aliases` / `korean_alias_*` 변경
- `field_weight_strategy` 변경

rationale 같은 메타 텍스트만 손볼 때는 bump 금지 (불필요한 임베딩 비용).

## 롤아웃 순서

1. 레시피 JSON 수정 (필요 시 `version` bump)
2. `pnpm run lint && pnpm run typecheck` 통과 확인
3. `pnpm run test:related -- scripts/etl/index-to-vespa.ts tools/embedding-recipe/embedding-recipe-v1.json` 통과 확인
4. 재임베딩 실행:
   ```bash
   pnpm tsx --env-file=.env scripts/etl/index-to-vespa.ts --input data/silver-trackc.ndjson
   ```
   기존 prepared feed artifact가 있으면 `semantic_summary` 불일치로 자동 cache miss → 비용은 발생하지만 강제 옵션 없이도 재생성됩니다.
5. Vespa schema 변경(있을 경우 동봉된 `wine_aware` rank profile fusion 등): `vespa deploy vespa/app/` 후
6. 수동 smoke probe:
   ```bash
   pnpm tsx tools/vespa-probe/probe-wine-aware-fusion.mts
   ```
   `learned_sparse_contribution`이 finite하고 wine_aware top-5가 토픽에 맞는지 확인.

전체 데이터 셋업 흐름은 [`project_vespa_data_setup`](../CLAUDE.md) 메모를 참조.

## 롤백

JSON `version`을 이전 값으로 되돌리고 4번 재실행. 이전 임베딩이 prepared feed에 남아 있다면 cache hit으로 즉시 복구됩니다 (LLM 비용 0).
