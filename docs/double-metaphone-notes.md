# Double Metaphone phonetic encoding

## What it is

Double Metaphone is a phonetic encoding algorithm published by Lawrence
Philips in the *C/C++ Users Journal* (June 2000). Given an input string,
it returns **two** phonetic codes:

- **Primary** — the anglicized pronunciation
- **Alternate** — the source-language pronunciation (e.g. French,
  German, Italian) when the spelling suggests a foreign origin

The implementation in this repo is the upstream
[`double-metaphone`](https://www.npmjs.com/package/double-metaphone)
npm package (MIT, pure ESM, no transitive deps, maintained by Titus
Wormer). The wrapper module `src/domain/alias/service/double-metaphone.ts`
adds repo conventions on top:

- Diacritic normalization (`Pétrus` → `Petrus`) before encoding
- An empty-input contract (`{ primary: '', alternate: null }`) instead
  of upstream's `['', '']`
- A runtime guard that fails loudly if the library output drifts from
  the published `[primary, alternate]` string-pair contract
- A `doubleMetaphoneKeys(input)` helper returning a set of distinct
  keys for cleaner intersection semantics at callsites

## Why two keys?

Wine names are dominated by foreign-origin proper nouns. The set of
spellings a user might type for a single entity is large:

| Entity | Spellings seen in production |
|---|---|
| Château Margaux | Margaux, Margeaux, Margoux, Margo, Margot |
| Sassicaia | Sassicaia, Sasicaia, Sasikaia |
| Bordeaux | Bordeaux, Bordo, Bourdeaux |
| Moët & Chandon | Moet Chandon, Moet Shandon |

A single-pronunciation encoder (Soundex, single Metaphone) collapses
these variants onto **one** code each. Some of those codes differ
between variants because the algorithm's rules trigger differently on
the alternate spellings. Double Metaphone keeps **both** pronunciations
on each side, then the matcher accepts overlap on either side — giving
recall on both "anglicized typo" and "foreign-influence typo" classes.

Concrete example:

```
Margaux   → primary=MRK, alternate=null
Margeaux  → primary=MRJ, alternate=MRK   ← alternate matches Margaux's primary
```

`doubleMetaphoneMatches('Margaux', 'Margeaux')` returns `true` via the
keyset intersection on `"MRK"`.

## Where it runs

- `src/domain/alias/service/double-metaphone.ts` — SSoT wrapper
- `src/infrastructure/adapter/pg-alias-matcher.ts` — Postgres-backed
  alias matcher. Uses DM in the client-side promotion logic
  (`resolveExactLookupStrategy`) and as a fuzzy-phase fallback signal
  (`bestFuzzySimilarity`). The SQL phonetic recall channel keeps the
  legacy compact-vowel-strip skeleton because PostgreSQL cannot
  express the Double Metaphone state machine in plain SQL.
- `src/infrastructure/adapter/search-snapshot-alias-matcher.ts` —
  in-memory matcher used by the search snapshot substrate. Builds a
  `doubleMetaphoneIndex` keyed by DM code → aliases at construction
  time and uses it both for candidate gathering and promotion.

## Korean / Hangul policy

Double Metaphone is defined only over Latin script. For Hangul input,
the wrapper returns `{ primary: '', alternate: null }` and the matcher
treats it as "no phonetic signal" rather than fabricating a match.

The transliteration pipeline (`Transliterator` and
`KOREAN_TRANSLITERATION_*` rules in
`src/domain/query/service/query-normalizer.ts`) is responsible for
romanizing Korean wine vocabulary before phonetic comparison runs.
After transliteration, Latin variants flow through the same DM path.

## Debugging "this should have matched"

When a real-world query *should* match phonetically but doesn't, the
debugging order is:

1. **Is the input Latin-script?** If not, the transliterator owns this
   case — Double Metaphone returns empty by design.
2. **Are diacritics being stripped?** `doubleMetaphone()` calls
   `stripAccents` internally. If the input is malformed (e.g. unpaired
   combining marks), the strip may leave residue that the library
   refuses to encode.
3. **Does the legacy `phoneticCompact` view still pollute the
   comparison?** The matcher accepts EITHER the legacy skeleton OR a
   DM keyset overlap. If both fail, the issue is upstream (the
   `double-metaphone` library disagrees with the published rules).
4. **Are both the query and alias getting encoded?** Use the
   `doubleMetaphone()` function directly in a REPL on both sides;
   trivially small reproductions are usually faster than tracing the
   matcher.

## Adding new wine-domain phonetic test cases

Append cases to:

- Wrapper unit tests:
  `src/domain/alias/service/__tests__/double-metaphone.test.ts`
- Matcher regression tests:
  `test/regression/double-metaphone-phonetic.regression.test.ts`

Both files are append-only — never delete a regression case. New cases
should follow the existing it.each pattern: `[query, expectedEntityId]`.

## Why not a stored procedure / PL/Postgres port?

The phonetic SQL recall channel uses a crude vowel-strip skeleton
because:

1. Double Metaphone has ~300 conditional state transitions; porting to
   PL/PG would require maintaining a parallel SSoT.
2. The SQL channel is *recall* only — false positives at the SQL layer
   are corrected by the client-side DM decision in
   `resolveExactLookupStrategy`.
3. The fuzzy phase already retrieves candidates via permissive
   trigrams; DM at the client correctly promotes phonetic hits to
   `phonetic_exact` regardless of which SQL channel caught them.

If recall ceiling becomes a bottleneck (rare entities not retrieved by
any existing SQL channel), the next step is a persistent
`phonetic_key` column on `aliases` populated by an ETL job — not a
PL/PG port.
