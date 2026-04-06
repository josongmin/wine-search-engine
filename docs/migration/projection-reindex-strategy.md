# Projection Reindex Strategy

**Status:** Wave 3 — T7.5 operational migration notes  
**Last updated:** 2026-04-07  
**Epic reference:** `docs/plans/apr-6-engine-v2/epic-7-index-projection-migration.md`

---

## 1. Decision: Full Reindex

**A full reindex is required for the T7.2 projection boundary deployment.**

The `hit_summary` and `feature_summary` document-summary blocks were introduced in T7.2 as named Vespa summaries inside `vespa-schema.sd`. Vespa only populates a named `document-summary` for documents that were fed *after* the summary block was deployed to the running container. Documents indexed before T7.2's schema deployment exist in the Vespa content layer but will return empty or missing fields when queried via `presentation.summary=hit_summary` or `presentation.summary=feature_summary`.

**Why not staged reindex?**  
Staged reindex (feeding only a slice and gradually expanding) would leave a mixed state where some documents return correct hit/feature projections while others return empty fields for the same summary names. This breaks the `fetchWithHitSummary()` and `fetchWithFeatureSummary()` callers in `vespa-search-index.ts`, which assume all returned hits carry the expected field set.

**Why not dual-write?**  
Dual-write to a V1 and V2 Vespa container would add operational complexity (two container configurations, two feed paths, two query routing layers) for a change that is additive at the document level. The `default` summary continues to serve all fields for existing callers; only the *named* summaries are new. A simpler rollback strategy (described in §5) is preferred.

**Summary of decision:**

| Strategy | Applicable? | Reason |
|---|---|---|
| Full reindex | **Yes — required** | Named summaries only populated for post-T7.2 fed documents |
| Staged reindex | No | Mixed projection state breaks named-summary consumers |
| Dual-write | No | Additive summary blocks do not require V2 container; rollback via V1 container is simpler |

---

## 2. Pre-Reindex Checklist

Before running the ETL feed, verify all of the following:

### 2a. Vespa schema deployment

- [ ] `vespa-schema.sd` version that includes `document-summary hit_summary { ... }` and `document-summary feature_summary { ... }` blocks is **deployed** to the target Vespa container.
- [ ] Deployment health: `GET http://<VESPA_URL>/ApplicationStatus` returns `200 OK` and shows the active config generation.
- [ ] Schema application status: run a test query and confirm `presentation.summary=hit_summary` does not return a 400 error.

### 2b. hit_summary block active

The `hit_summary` block must list these fields (confirm in `vespa-schema.sd`):

```
entity_id, canonical_label, producer, region, appellation,
grape_primary, vintage_year, search_text_en, producer_prestige
```

Verify: `GET http://<VESPA_URL>/document/v1/wine/wine_entity/docid/<any-id>?summary=hit_summary` returns only these fields (after initial documents are fed).

### 2c. feature_summary block active

The `feature_summary` block must list these fields (confirm in `vespa-schema.sd`):

```
entity_id, body, tannin, acidity, sweetness, critic_score_normalized,
drinking_window_start, drinking_window_end, drinking_window_model_version
```

Verify: `GET http://<VESPA_URL>/document/v1/wine/wine_entity/docid/<any-id>?summary=feature_summary` returns only these fields.

### 2d. learned_sparse_weights rank profile active

The `learned_sparse` rank profile uses `dotProduct(learned_sparse_weights, sparse_query_embedding)`. Confirm it is present in the deployed schema by querying with `ranking=learned_sparse` — it should not return a 400 error.

### 2e. Silver NDJSON input ready

- [ ] `data/silver-docquery.ndjson` (or the target `--input` path) is present and non-empty.
- [ ] The NDJSON has been through the full enrichment pipeline (aliases, Track C fields, drinking window).

---

## 3. Reindex Steps

Run these steps in order. Do not proceed to the next step if a step fails.

### Step 1 — Deploy schema

Deploy `src/infrastructure/vespa/vespa-schema.sd` to the target Vespa container. Confirm the config generation advances and the container is healthy.

### Step 2 — Run ETL to generate / validate NDJSON

If the Silver NDJSON is not already current, run the full pipeline (Bronze → Silver → Enrich → Track C). The indexer reads `data/silver-docquery.ndjson` by default.

Smoke-validate the NDJSON (optional but recommended):

```bash
npx tsx --env-file=.env scripts/etl/index-to-vespa.ts --input data/silver-docquery.ndjson --dry-run --limit 5
```

### Step 3 — Feed via index-to-vespa.ts

```bash
npx tsx --env-file=.env scripts/etl/index-to-vespa.ts \
  --input data/silver-docquery.ndjson
```

The script feeds in batches of 50. It exits non-zero if any batch has failures. Monitor the progress output: `Progress: N/M batches (X indexed, Y failed)`.

Key env vars:

| Variable | Purpose | Default |
|---|---|---|
| `VESPA_URL` | Target Vespa container URL | `http://localhost:8080` |
| `EMBEDDING_SERVICE_URL` | BGE-M3 embedding endpoint | unset → deterministic fallback |
| `EMBEDDING_MODEL` | Embedding model name | `bge-m3` |

### Step 4 — Run ingest smoke test

```bash
npm run test:e2e:vespa:smoke
```

Or directly:

```bash
npx tsx --env-file=.env scripts/etl/run-ingest-indexing-smoke.ts
```

The smoke test feeds synthetic fixtures, verifies sparse retrieval (`sparseSearch`), and cleans up. It must pass before proceeding.

### Step 5 — Spot-check projection boundary fields

Run the projection spot-check script to verify `hit_summary` and `feature_summary` are returning the expected fields:

```bash
npx tsx --env-file=.env scripts/etl/smoke-check-projections.ts
```

Expected output:

```
[hit_summary]  PASS  entity_id present
[hit_summary]  PASS  canonical_label present
[hit_summary]  PASS  producer present
[feature_summary]  PASS  entity_id present
[feature_summary]  PASS  body in [0,1]
All projection checks passed.
```

If any check shows `FAIL`, do not cut over DNS. See §5 (Rollback Plan).

---

## 4. Field Ownership Table

Maps each Vespa `wine_entity` field to its projection family.

**Legend:**
- `hit` — `RetrievalHitProjection` (served via `hit_summary`; used by `fetchWithHitSummary()`)
- `feature` — `RetrievalFeatureProjection` (served via `feature_summary`; used by `fetchWithFeatureSummary()`)
- `payload` — stored in the index, returned only by the `default` summary; not in either named projection
- `retrieval` — required at query time for sparse/dense/hybrid retrieval; not in named summaries

| Vespa field name | Projection family | Notes |
|---|---|---|
| `entity_id` | hit + feature | Present in both summaries as the join key |
| `canonical_label` | hit | Display label; indexed for BM25 |
| `producer` | hit | Display label; indexed for BM25 |
| `region` | hit | Display label |
| `appellation` | hit | Display label (optional) |
| `grape_primary` | hit | Display label (optional) |
| `vintage_year` | hit | Display integer (optional) |
| `search_text_en` | hit | English full-text field |
| `producer_prestige` | hit | Prestige score [0,1] |
| `body` | feature | Sensory score [0,1] |
| `tannin` | feature | Sensory score [0,1] (optional) |
| `acidity` | feature | Sensory score [0,1] (optional) |
| `sweetness` | feature | Sensory score [0,1] |
| `critic_score_normalized` | feature | Normalized critic score [0,1] (optional) |
| `drinking_window_start` | feature | First year of drinking window (optional) |
| `drinking_window_end` | feature | Last year of drinking window (optional) |
| `drinking_window_model_version` | feature | Model version string (optional) |
| `entity_type` | payload | Type discriminator; always `"wine"` |
| `aliases_identity_safe` | payload + retrieval | Identity-safe alias array; indexed for BM25 |
| `aliases_noisy_recall` | payload + retrieval | Noisy recall alias array; indexed for BM25 |
| `grapes` | payload | Full grape variety array |
| `search_text_ko` | payload + retrieval | Korean text field; indexed for BM25 |
| `semantic_summary` | payload | Text for embedding generation |
| `style` | payload | Style label (e.g. `"bold red"`) |
| `price_band` | payload | Price band label |
| `pairing` | payload | Food pairing tag array |
| `occasion` | payload | Occasion tag array |
| `availability` | payload | Availability boolean |
| `popularity_score` | payload + retrieval | Used in `popularity_native` rank profile |
| `embedding` | retrieval | Dense vector tensor (1024 dims, angular distance) |
| `learned_sparse_weights` | retrieval | SPLADE sparse tensor |
| `wine_type` | payload | Wine type enum string |
| `country` | payload | Country of origin |
| `price_usd` | payload | Price in USD |
| `flavor_profiles` | payload | Flavor descriptor array |
| `alcohol_pct` | payload | Alcohol by volume |
| `certifications` | payload | Certification tag array |

**Fields NOT in named summaries:**  
`entity_type`, `aliases_identity_safe`, `aliases_noisy_recall`, `grapes`, `search_text_ko`, `semantic_summary`, `style`, `price_band`, `pairing`, `occasion`, `availability`, `popularity_score`, `embedding`, `learned_sparse_weights`, `wine_type`, `country`, `price_usd`, `flavor_profiles`, `alcohol_pct`, `certifications`. These are accessible only through the `default` summary (all-fields) or via the Vespa Document API.

---

## 5. Rollback Plan

### When to roll back

Roll back if any of the following occur after the full reindex:

1. `npm run test:e2e:vespa:smoke` fails after Step 4.
2. `scripts/etl/smoke-check-projections.ts` reports `FAIL` for any check after Step 5.
3. Production query latency degrades more than 20% vs. pre-reindex baseline.
4. Named summary queries (`presentation.summary=hit_summary` or `feature_summary`) return HTTP 4xx errors.

### Rollback procedure

1. **Keep V1 Vespa container running in parallel** during the reindex. Do not decommission the V1 container until all smoke checks in Steps 4 and 5 pass.
2. **DNS / load balancer cutover only after full smoke.** Point `VESPA_URL` (or the equivalent service discovery entry) at the new container only after all checks pass. The V1 container continues to serve production traffic until that point.
3. **If rollback is needed:** Repoint `VESPA_URL` back to the V1 container. No schema rollback is needed on the V1 container since no schema changes were applied to it.
4. **Investigate:** Review Vespa container logs and the output of `smoke-check-projections.ts` to identify which field or summary block is missing. Re-deploy the schema to the V2 container and re-run from Step 1.

### Post-rollback validation

After reverting to V1, confirm that:
- `npm run test:e2e:vespa:smoke` passes against V1.
- Existing search queries return results via the `default` summary.

---

## 6. References

- Vespa schema: `src/infrastructure/vespa/vespa-schema.sd`
- Projection model: `src/domain/retrieval/model/retrieval-document.ts`
- Named summary consumers: `src/infrastructure/vespa/vespa-search-index.ts` (`fetchWithHitSummary`, `fetchWithFeatureSummary`)
- ETL indexer: `scripts/etl/index-to-vespa.ts`
- Smoke test: `scripts/etl/run-ingest-indexing-smoke.ts`
- Projection spot-check: `scripts/etl/smoke-check-projections.ts`
- Epic spec: `docs/plans/apr-6-engine-v2/epic-7-index-projection-migration.md`
