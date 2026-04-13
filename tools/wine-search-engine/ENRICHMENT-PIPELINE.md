# Current ETL Artifact Contract

이 문서는 현재 구현의 파일 계약만 적는 짧은 안내서입니다. SSOT는 [`scripts/etl/artifact-contract.ts`](../../scripts/etl/artifact-contract.ts) 와 [`docs/system-overview/ingestion-pipeline.md`](../../docs/system-overview/ingestion-pipeline.md) 입니다.

## Canonical Graph

```text
data/silver.ndjson
  -> data/silver-aliases.ndjson
  -> data/silver-ko.ndjson
  -> data/silver-docquery.ndjson
  -> data/silver-trackc.ndjson
  -> Vespa `wine_entity`
```

## Stage Contract

| Stage | Input | Output |
|------|------|------|
| `vivino-to-silver.ts` | Bronze PG | `data/silver.ndjson` |
| `generate-aliases.ts` | `data/silver.ndjson` | `data/silver-aliases.ndjson` |
| `generate-korean-aliases.ts` | `data/silver-aliases.ndjson` | `data/silver-ko.ndjson` |
| `generate-doc-queries.ts` | `data/silver-ko.ndjson` | `data/silver-docquery.ndjson` |
| `run-track-c.ts` | `data/silver-docquery.ndjson` | `data/silver-trackc.ndjson` |
| `validate-silver.ts` | `data/silver-trackc.ndjson` | `data/silver-quality-report.json` |
| `index-to-vespa.ts` | `data/silver-trackc.ndjson` | Vespa feed |
| `build-search-snapshot.ts` | `data/silver-trackc.ndjson` | snapshot manifest |
| `publish-search-snapshot.ts` | `data/silver-trackc.ndjson` | runtime cutover |

## Full Pipeline

```bash
pnpm run etl:silver
pnpm run etl:aliases
pnpm run etl:korean-aliases
pnpm run etl:doc-queries
pnpm run etl:track-c
pnpm run etl:validate
pnpm run etl:index
```

`etl:full` runs the same chain end-to-end.
