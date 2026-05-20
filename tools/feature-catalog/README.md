# Feature Catalog

레포의 주요 기능(검색/RAG/NLU/i18n/ETL/Eval/Observability/...)을 YAML로 관리하고
**maturity 1-5** 척도로 완성도를 추적하는 카탈로그.

## Layout

```
tools/feature-catalog/
├── schema/feature.schema.ts        # Zod 스키마 (SSoT)
├── features/<category>/*.yaml      # 한 기능 = 한 YAML
├── lib/                            # load / lint / render / stats
├── bin/catalog.ts                  # CLI 엔트리포인트
└── dist/                           # 빌드 산출물 (gitignored)
    ├── CATALOG.md                  # 메인 인덱스
    ├── by-maturity.md              # 성숙도 기준 분류
    └── features/<id>.md            # 기능별 상세
```

## Commands

```bash
pnpm run catalog:build      # YAML -> dist/*.md (validate + lint + render)
pnpm run catalog:validate   # 검증만 (CI 게이트용)
pnpm run catalog:stats      # 분포 요약
pnpm run catalog:show <id>  # 단일 기능 콘솔 출력
```

## Maturity scale (1-5)

CLAUDE.md의 "SOTA++ baseline" 정책과 정렬:

| 점수 | 라벨 | 기준 |
|---|---|---|
| **1** | Concept/Stub | RFC만 있거나 stub 함수만. 프로덕션 미연결 |
| **2** | Prototype | 1개 경로 구현, happy path만 동작, 테스트 미흡 |
| **3** | Functional | 프로덕션 와이어링 완료, regression test 일부 |
| **4** | Production | regression suite + observability + 엣지케이스 커버 |
| **5** | SOTA++ | 도메인 best-in-class, eval로 입증, 회귀 게이트 운영 |

## YAML 작성 가이드

- `id`: `category.kebab-name` 형식. **카테고리 prefix 필수**.
- `maturity_rationale`: "왜 X점인가" 명시. 점수 자체보다 이게 더 중요.
- `last_reviewed`: 변경 시 갱신. 180일 초과 시 lint warn.
- `key_files`, `tests.*`, `related_rfcs`: 레포 root 기준 상대 경로. **존재해야 함** (lint error).
- `depends_on`: 다른 feature id. **존재해야 함**. self-reference + cycle 금지.

스키마 전체는 [`schema/feature.schema.ts`](./schema/feature.schema.ts) 참고.

## 메인터넌스 룰

코드 변경 시 카탈로그 동기화는 CLAUDE.md의 **Feature Catalog — keep in sync** 섹션 참고.

요약:
- 기능 개선 -> `maturity` 갱신 + `last_reviewed` 갱신 + `maturity_rationale` 재작성
- 새 기능 추가 -> 새 YAML 제안
- 파일 이동/리네임 -> `catalog:validate`가 CI에서 잡음

## Categories

`retrieval` | `agent` | `nlu` | `korean-i18n` | `tools` | `eval` | `etl` | `observability` | `security` | `infra`

새 카테고리가 필요하면 [`schema/feature.schema.ts`](./schema/feature.schema.ts)의 `CategorySchema`에 추가.
