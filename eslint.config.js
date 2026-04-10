import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'eslint.config.js',
      '.claude/**',
      'web/**',
      'debug-vespa-fields.ts',
      '**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['scripts/**/*.ts', 'tools/**/*.ts', 'config/**/*.ts', '*.config.ts', '*.config.*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**/*.ts', 'tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      /**
       * Bugbash-derived: `value || default` silently replaces valid zero/empty-string.
       * Use `??` (nullish coalescing) which only triggers on null/undefined.
       * See CLAUDE.md rule 26.
       */
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignorePrimitives: { bigint: true, boolean: true },
        },
      ],
      /**
       * Bugbash-derived: Array.sort() without comparator uses lexicographic order,
       * which silently mis-sorts numbers ([1,10,2] instead of [1,2,10]).
       * See bugbash section F (tiebreaker/NaN policy).
       */
      '@typescript-eslint/require-array-sort-compare': [
        'error',
        { ignoreStringArrays: true },
      ],
      /** DP / index-heavy code still uses `!`; tighten incrementally. */
      '@typescript-eslint/no-non-null-assertion': 'off',
      /**
       * Fully ban console in production src/ — use bootstrapLogger or
       * a pino child logger instead. console.warn/error bypasses pino
       * serializers (leaking SQL params, connection strings) and is
       * invisible to structured-log tooling. (Bugbash pattern #2)
       */
      'no-console': 'error',
      /**
       * Bugbash-derived safety rules — prevent the top recurring bug classes.
       * Each pattern was found 10+ times across the codebase during the
       * audit; these selectors catch new instances at lint time.
       */
      'no-restricted-syntax': [
        'error',
        {
          // Math.max(...spread) / Math.min(...spread) — stack overflow on large arrays.
          // Use a loop instead (see CLAUDE.md rule 9).
          selector: 'CallExpression[callee.object.name="Math"][callee.property.name=/^(max|min)$/] > SpreadElement',
          message: 'Math.max/min with spread can overflow the call stack on large arrays. Use a loop.',
        },
        {
          // toLocaleString() produces locale-dependent output (e.g. "70.000" in de-DE).
          // Never use in query strings, API calls, or serialization. See CLAUDE.md rule 21.
          selector: 'CallExpression[callee.property.name="toLocaleString"]',
          message: 'toLocaleString() is locale-dependent. Use .toString() or template literals for deterministic output. (CLAUDE.md rule 21)',
        },
        {
          // JSON.parse(x) as T — unsafe cast on external data. Cast to unknown first,
          // then use Zod or a runtime type guard. See CLAUDE.md rule 12.
          // Exception: `as unknown` itself is allowed (it's the first step of the safe pattern).
          // Exception: infrastructure adapter generic get<T> methods are handled by
          // the consistent-type-assertions rule on pg-*/redis-* files.
          selector:
            'TSAsExpression[typeAnnotation.typeName.name!="unknown"][typeAnnotation.type!="TSUnknownKeyword"] > CallExpression[callee.object.name="JSON"][callee.property.name="parse"]',
          message:
            'JSON.parse result must be cast to unknown first, then validated with Zod or a type guard. (CLAUDE.md rule 12)',
        },
        {
          // JSON.parse(x) as unknown as T — double cast bypasses the single-cast rule above.
          // Assign to `const x: unknown = JSON.parse(...)`, then validate and narrow.
          selector:
            'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"] > CallExpression[callee.object.name="JSON"][callee.property.name="parse"]',
          message:
            'JSON.parse(...) as unknown as T bypasses the safety rule. Assign to a `const x: unknown` variable first, then validate shape. (CLAUDE.md rule 12)',
        },
        {
          // \b word boundary is ASCII-only — silently fails on Korean/accented Latin.
          // 50+ instances of this bug were found in audit rounds 22-27.
          // Use (?:^|[^\p{L}\p{N}])...(?=$|[^\p{L}\p{N}]) with /u flag instead.
          // See CLAUDE.md rule 8. Catches: /pattern\b/  /\bpattern/  /\b/
          selector: 'Literal[regex.pattern=/\\\\b/]',
          message: '\\b word boundary is ASCII-only and silently fails on Korean/accented Latin. Use Unicode-aware boundaries with /u flag. (CLAUDE.md rule 8)',
        },
        {
          // Regex containing Korean characters (Hangul range U+AC00–U+D7A3) without the /u flag.
          // Without /u, Unicode escapes and character class behavior may silently mismatch.
          // Matches: /한글/ but not /한글/u — catches the class of bugs in CONSTRAINT_KEYWORDS.
          selector: 'Literal[regex.pattern=/[\\u0080-\\uFFFF]/][regex.flags!=/u/]',
          message: 'Regex containing non-ASCII characters must use the /u flag for correct Unicode semantics. (CLAUDE.md rule 8)',
        },
        {
          // .includes("") always returns true — any string contains the empty string.
          // Common bug: `arr.filter(kw => answer.includes(kw))` with empty-string keywords
          // silently gives free hits. Guard with `kw.trim().length > 0` before .includes().
          // Found in: scorer.ts goldenKeywords recall scoring (session audit).
          selector: 'CallExpression[callee.property.name="includes"] > Literal[value=""]',
          message: '.includes("") always returns true. Filter out empty strings before calling .includes(). (scorer.ts goldenKeywords bug)',
        },
        {
          // .slice(0, N - X) without Math.max(0, ...) guard: when N < X, the subtraction
          // is negative and .slice(0, -k) silently returns "" (empty string), then appending
          // a suffix creates output LONGER than the intended limit.
          // Always wrap: Math.max(0, N - X) before passing to .slice().
          // Found in: agent-prompt.ts truncateObservation (session audit).
          selector: 'CallExpression[callee.property.name="slice"] > BinaryExpression[operator="-"]:not(CallExpression[callee.object.name="Math"][callee.property.name="max"] > BinaryExpression[operator="-"])',
          message: '.slice(0, N - X) can produce negative indices when N < X, returning "" then violating the length contract. Use Math.max(0, N - X). (truncateObservation bug)',
        },
        {
          // \p{L}\p{N} without brackets means AND (two-char sequence), not OR.
          // The correct form is [\p{L}\p{N}] (character class). This was the #1 bug
          // found in the ingestion pipeline audit — vintage years parsed as volumes.
          // NOTE: ESLint selectors cannot distinguish [\\p{L}\\p{N}] from \\p{L}\\p{N}
          // in regex.pattern, so this rule uses a negative lookbehind for '[' and '^'
          // to avoid false positives on already-correct bracketed forms including
          // negative character classes like [^\\p{L}\\p{N}].
          selector: 'Literal[regex.pattern=/(?<![\\[^])\\\\p\\{[LN]\\}\\\\p\\{[LN]\\}(?!\\])/]',
          message: '\\p{L}\\p{N} without brackets means AND (letter then digit), not OR. Use [\\p{L}\\p{N}] character class instead. (Ingestion audit bug #1)',
        },
        // NOTE: Math.random() is NOT banned via lint — it has legitimate uses
        // for jitter/delay in retry logic. The CLAUDE.md quality bar prohibits
        // Math.random() for ID generation (use crypto.randomUUID() instead).
        // This is enforced via code review, not lint.
        {
          // Time-unit literals hardcoded instead of using time-units.ts SSoT.
          // Catches the most common offenders: 86400 (1 day s), 3600 (1 h s),
          // 7200 (2 h s), 1800 (30 min s) as standalone numeric literals.
          // Rule 30: domain constants used in 2+ files must live in a shared module.
          // Fix: import { HOURS_PER_DAY, MINUTES_PER_HOUR, SECONDS_PER_MINUTE }
          //       from '...shared/utils/time-units.js'
          selector: 'Literal[value=86400], Literal[value=3600], Literal[value=7200], Literal[value=1800]',
          message:
            'Hard-coded time constant. Use named exports from time-units.ts SSoT ' +
            '(HOURS_PER_DAY, MINUTES_PER_HOUR, SECONDS_PER_MINUTE, MS_PER_HOUR, …). (CLAUDE.md rule 30)',
        },
        {
          // Bugbash fallback/heuristic audit: catch `|| 0` on numeric values.
          // `value || 0` replaces legitimate zero with 0 (tautology), losing
          // the distinction between "zero" and "absent". Use `?? 0` instead.
          // Already covered by prefer-nullish-coalescing for most cases, but
          // this catches `|| 0` in direct numeric arithmetic that the TS rule
          // may not flag (e.g. `x + (y || 0)`).
          selector: 'LogicalExpression[operator="||"][right.value=0]',
          message: '`|| 0` silently replaces legitimate zero values. Use `?? 0` (nullish coalescing) to only replace null/undefined. (CLAUDE.md rule 26)',
        },
        {
          // Catch `score *= <number literal>` inside function bodies — magic
          // multipliers in scoring logic are unauditable. CLAUDE.md rule 15:
          // "Extract as named const with comment explaining the value."
          selector: 'AssignmentExpression[operator="*="][right.type="Literal"][right.value!=-1][right.value!=0][right.value!=1][right.value!=2][right.value!=10][right.value!=100]',
          message: 'Magic multiplier in scoring logic. Extract as a named const at module scope with a comment. (CLAUDE.md rule 15)',
        },
        {
          // `|| <numeric literal>` on a non-zero literal — same class of bug as `|| 0`
          // but for any "default value" pattern where 0 / '' / false should NOT
          // collapse to the default. e.g. `confidence || 0.5` silently overrides
          // a real 0.0 confidence with the neutral midpoint.
          // (Phase B audit: ltr-features.ts DEFAULT_NEUTRAL_CONFIDENCE bug)
          selector: 'LogicalExpression[operator="||"][right.type="Literal"][right.value!=0][right.raw!=/^["\'`]/]',
          message: '`|| <number>` silently replaces legitimate 0/false/empty values with the literal. Use `?? <number>` (nullish coalescing) instead. (CLAUDE.md rule 26)',
        },
        {
          // Truthy check on a value that is OBVIOUSLY a typed array
          // (member access like `if (foo.embedding)` or `if (foo.results)`).
          // This is a heuristic — not all bare member-access truthy checks are
          // typed arrays — but the named ones below were the recurring bug class.
          // (CLAUDE.md rule 32; Bugbash audit P1-9)
          selector:
            'IfStatement > MemberExpression[property.name=/^(embedding|embeddings|results|hits|candidates|matchedConstraints|aliases|grapes|pairing|occasion|softBoosts|inferredBoosts|filtersApplied|skippedPhases)$/]',
          message: 'Truthy check on a typed array — empty array `[]` is truthy. Use `arr != null && arr.length > 0` for "has elements" or `arr != null` for "exists". (CLAUDE.md rule 32)',
        },
        {
          // `new Date(x).getTime()` without `Number.isFinite` guard.
          // Invalid date strings produce NaN, and NaN comparisons are always
          // `false`, silently dropping records or bypassing validation.
          // (CLAUDE.md rule 28; Phase A audit watchlist.schema.ts bug)
          // This selector catches the .getTime() call directly on a `new Date(...)` expression.
          // The fix is to assign to a variable, then guard with Number.isFinite before comparison.
          selector:
            'BinaryExpression > CallExpression[callee.object.type="NewExpression"][callee.object.callee.name="Date"][callee.property.name="getTime"]',
          message: '`new Date(x).getTime()` produces NaN on invalid input — NaN comparisons silently return false. Assign to a variable, guard with Number.isFinite, then compare. (CLAUDE.md rule 28)',
        },
        {
          // Empty catch block — `catch {}` or `catch (err) {}` with no body.
          // The 30-round audit found these silently swallow real bugs. If the
          // catch is intentional (speculative parse, optional cleanup), the body
          // must reference the error: `catch (err) { void err; /* reason */ }`.
          selector: 'CatchClause[body.body.length=0]',
          message: 'Empty catch block silently swallows errors. Either log via bootstrapLogger, mark intentional with `void err; /* reason */`, or re-throw. (Bugbash silent-fallback class)',
        },
        {
          // z.string().transform(Number) without a prior .min(1) guard.
          //
          // Root cause: Number("") === 0 which is finite, so
          // .pipe(z.number().finite()) silently accepts the empty string and maps
          // it to 0. This was found in zod-coerce.ts (fixed) and independently
          // in llm-relevance-labeler.ts (same bug, different file).
          //
          // Safe pattern: z.string().min(1).transform(Number)
          // SSoT: import coerceFiniteNumber from
          //   src/domain/shared/utils/zod-coerce.ts
          selector:
            'CallExpression[callee.property.name="transform"][arguments.0.name="Number"]:not([callee.object.type="CallExpression"][callee.object.callee.property.name="min"])',
          message:
            'z.string().transform(Number) without .min(1) silently maps "" to 0 (Number("") === 0 is finite). ' +
            'Use z.string().min(1).transform(Number) or import coerceFiniteNumber from zod-coerce.ts. ' +
            '(BUG-DS02 audit: empty-string silent zero)',
        },
        {
          // Inline clamp to [0,1] — use clamp01() from shared/utils/clamp.ts SSoT.
          // Math.max(0, Math.min(1, x)) and Math.min(1, Math.max(0, x)) are both
          // inline duplicates that don't emit NaN warnings and hide data pipeline bugs.
          // Import clamp01 from src/domain/shared/utils/clamp.ts instead.
          // (CLAUDE.md rule 30: domain constants/utils in 2+ files → single SSoT)
          // Selector: Math.max(0, Math.min(1, x)) — the second arg of Math.min must be Literal 1.
          // This avoids false-positives on Math.max(0, Math.min(index, arr.length-1)) (array bound clamps).
          selector:
            'CallExpression[callee.object.name="Math"][callee.property.name="max"] > Literal[value=0] ~ CallExpression[callee.object.name="Math"][callee.property.name="min"] > Literal[value=1]:nth-child(1)',
          message:
            'Inline Math.max(0, Math.min(1, x)) is a clamp01 duplicate. Import clamp01 from src/domain/shared/utils/clamp.ts — it also emits NaN warnings that the inline form silently drops. (CLAUDE.md rule 30)',
        },
        {
          // parseInt() without explicit radix.
          // Omitting radix is ambiguous: "010" parses as 8 (octal) in older engines,
          // 10 in ES5+ strict mode. Always pass 10 (or 16 for hex) explicitly.
          // (CLAUDE.md rule 12 — external data coercion)
          selector:
            'CallExpression[callee.name="parseInt"][arguments.length=1],' +
            'CallExpression[callee.type="MemberExpression"][callee.property.name="parseInt"][arguments.length=1]',
          message:
            'parseInt() requires an explicit radix as the 2nd argument (e.g. parseInt(s, 10)). ' +
            'Omitting it signals intent ambiguity. (CLAUDE.md rule 12 — external data coercion)',
        },
        {
          // Local re-definition of the zod-coerce.ts SSoT utilities.
          //
          // coerceFiniteNumber / coercePositiveInt / coerceNonNegativeInt are the
          // canonical Zod coercion helpers in src/domain/shared/utils/zod-coerce.ts.
          // Redefining them locally leads to diverging behaviour — llm-relevance-labeler.ts
          // had the exact same empty-string → 0 bug because it predated the .min(1) fix.
          //
          // Import from the SSoT module. (CLAUDE.md rules 25 + 30)
          selector:
            'VariableDeclarator[id.name=/^coerce(FiniteNumber|PositiveInt|NonNegativeInt)$/],' +
            'FunctionDeclaration[id.name=/^coerce(FiniteNumber|PositiveInt|NonNegativeInt)$/]',
          message:
            'Local coerce{FiniteNumber,PositiveInt,NonNegativeInt} re-implementation shadows the SSoT. ' +
            'Import from src/domain/shared/utils/zod-coerce.ts. ' +
            'Local copies drift silently — the empty-string → 0 bug originated here. ' +
            '(CLAUDE.md rules 25 + 30)',
        },
        {
          // Static `new Set([literal1, literal2, ...])` inside a function body.
          // Rule 16: if the Set value is deterministic (same every call), define
          // at module scope. Repeated allocation wastes memory and hides the invariant.
          // Fix: `const FOO_SET = new Set(['a', 'b'])` at module scope.
          // Exception: `new Set([...spread1, ...spread2])` is dynamic (depends on args).
          selector:
            ':not(:matches(Program, ExportNamedDeclaration, ExportDefaultDeclaration)) > VariableDeclaration > VariableDeclarator > NewExpression[callee.name="Set"] > ArrayExpression:not(:has(SpreadElement)):not(:has(Identifier)):not(:has(MemberExpression)):not(:has(CallExpression))',
          message:
            'new Set([literal, literal]) inside a function body allocates on every call. ' +
            'Define as a named const at module scope (Rule 16). ' +
            'Example: `const FOO_SET = new Set([\'a\', \'b\'])`',
        },
        {
          // `field !== 0` / `field === 0` as an "is present?" guard on [0,1]-normalised
          // numeric fields silently drops wines where the value is legitimately zero
          // (e.g. body=0 for very light pétillant, sweetness=0 for bone-dry wine).
          //
          // Root cause (E1-P3-7): `doc.body !== 0` was used as the "body is indexed"
          // guard. Any wine with body=0 was treated as "not indexed" and had the field
          // omitted from the feature projection sent to Vespa — collapsing ranking for
          // an entire class of light-bodied wines.
          //
          // Correct pattern: `field != null` to test presence; `field === 0` only
          // when you explicitly mean "the value is zero".
          //
          // Selector fires when a strict equality/inequality to 0 is applied
          // directly to a member expression whose property name is one of the
          // known [0,1]-normalised sensory or score fields.
          // (CLAUDE.md rule 26 extended; E1 bugbash audit)
          selector:
            'BinaryExpression[operator=/^(!==|===)$/][right.value=0]' +
            ' > MemberExpression[property.name=/^(body|sweetness|tannin|acidity|finishLength|finish_length|criticScoreNormalized|drinkingWindowStart|drinkingWindowEnd|producerPrestige|producer_prestige)$/]',
          message:
            '`field !== 0` / `field === 0` is a broken "present" guard for [0,1]-normalised fields — ' +
            'it silently drops wines where the value is legitimately 0 (e.g. light body, dry sweetness). ' +
            'Use `field != null` to test presence; `field === 0` only when you explicitly mean zero. ' +
            '(E1-P3-7 audit; CLAUDE.md rule 26)',
        },
      ],
      // NOTE (E4 audit 2026-04-11): Math.max(rawOffset + 1, otherRawOffset) is an unsafe
      // end>start guard when both offsets can be negative. The correct pattern is
      // Math.max(absoluteStart + 1, Math.round(base + endOffset)) — uses absolute years,
      // not relative offsets. See drinking-window-predictor.ts ONNX path + regression test.
      // An AST-level lint rule was explored but produces too many false positives on valid
      // Math.max(start + 1, ...) patterns. The semgrep rule covers this instead.
      /**
       * Numeric constants in src/ must be named module-scope consts.
       * Catches function-internal timeout literals like `const X = 12_000` inside a
       * function body — forces extraction to module scope (CLAUDE.md rule 15).
       * Generous ignore list to avoid noise on trivial arithmetic.
       */
      'no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1, 2, 3, 10, 100, 1000],
          ignoreArrayIndexes: true,
          enforceConst: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
        },
      ],
    },
  },
  /**
   * zod-coerce.ts IS the SSoT for coerceFiniteNumber / coercePositiveInt /
   * coerceNonNegativeInt.  The two rules below forbid re-defining those names
   * anywhere else, but the SSoT file itself must be exempt.
   */
  {
    files: ['src/domain/shared/utils/zod-coerce.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  /**
   * clamp.ts IS the SSoT for clamp01/clamp. The rule forbidding inline
   * Math.max(0, Math.min(1, x)) must not fire on its own implementation.
   */
  {
    files: ['src/domain/shared/utils/clamp.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  /** Infrastructure adapter boundary safety.
   *  Warn (not error) on `as` casts at JSONB/Redis boundaries so new code
   *  gets flagged in the editor while existing casts are cleaned up
   *  incrementally. Promote to 'error' once all existing casts are removed.
   */
  {
    files: ['src/infrastructure/adapter/pg-*.ts', 'src/infrastructure/cache/redis-*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'warn',
        {
          assertionStyle: 'never',
        },
      ],
    },
  },
  /**
   * Tests + src/__tests__: mocks, stubs, and Vitest patterns.
   * no-magic-numbers stays on for production src (see src block above). This block
   * matches Vitest files (*.test.ts, __tests__, test/) and turns that rule off — same
   * effective posture as code under test/.
   */
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      /**
       * Tests legitimately exercise deprecated APIs to verify backward
       * compatibility (dual-write parity, regression tests for migration
       * fallbacks). Production src/ keeps no-deprecated as error.
       */
      '@typescript-eslint/no-deprecated': 'off',
      /**
       * Re-enabled for tests: unused variables in test code are dead leftovers
       * (e.g. seenIndices pushed-to but never read) that mask bugs.
       * Prefix with `_` if intentionally unused (e.g. destructuring holes).
       * Promoted from warn → error: all existing violations were cleaned up.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      'no-magic-numbers': 'off',
      /**
       * Test fixtures legitimately use raw TTL literals (e.g. 3600, 86400) as
       * explicit, readable test-data values. The time-units SSoT rule targets
       * production src/ only — testing that "TTL is 3600" is clearer than
       * "TTL is MINUTES_PER_HOUR * SECONDS_PER_MINUTE".
       */
      'no-restricted-syntax': 'off',
    },
  },
  /**
   * Benchmark scoring code — stricter than general test code. Magic numbers
   * in scorer/judge produce hard-to-audit penalty logic. Extracted constants
   * are easier to review and modify.
   */
  {
    files: ['test/benchmark/**/*.ts'],
    ignores: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: {
      'no-magic-numbers': [
        'warn',
        {
          ignore: [0, 1, -1, 2, 100, 1000],
          ignoreArrayIndexes: true,
          enforceConst: true,
          ignoreDefaultValues: true,
        },
      ],
    },
  },
  /** Agent benchmark drivers: many statistical literals; keep lint noise low. */
  {
    files: [
      'test/benchmark/agent/judge.ts',
      'test/benchmark/agent/runner.ts',
      'test/benchmark/agent/scenarios.ts',
      'test/benchmark/agent/scorer.ts',
      // Adversarial scenarios use domain-specific pathological literals (repeat counts,
      // injection lengths) that are intentional test parameters — not auditable thresholds.
      'test/benchmark/agent/scenarios.adversarial.ts',
      'test/benchmark/agent/scenarios.coverage.ts',
    ],
    rules: {
      'no-magic-numbers': 'off',
    },
  },
  /**
   * Scenario authoring safety rules — catch common scenario design bugs at lint time.
   * These rules apply to all scenario definition files.
   *
   * Rules enforced:
   *  1. goldenEntityIds is a removed field (v3 breaking change). Any reference is a bug.
   *  2. answerMustNotMatch patterns that are bare Korean apology words (no anchor/verb-form)
   *     produce false positives on polite preambles like "죄송합니다만, 추천드립니다".
   *     Require verb-ending or sentence-terminal forms instead.
   */
  {
    files: [
      'test/benchmark/agent/scenarios.ts',
      'test/benchmark/agent/scenarios.adversarial.ts',
      'test/benchmark/agent/scenarios.coverage.ts',
      'test/benchmark/agent/scenario.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // goldenEntityIds was removed in SOTA++ v3 — use goldenKeywords instead.
          // Any property key or string literal with this name is a v2 leftover.
          selector: 'Property[key.name="goldenEntityIds"], Property[key.value="goldenEntityIds"]',
          message:
            'goldenEntityIds was removed in SOTA++ v3 (entity IDs are vivino-hash, not slugs). Use goldenKeywords with canonical-label fragments instead.',
        },
        {
          // Bare '죄송합니다' in answerMustNotMatch matches polite preambles like
          // "죄송합니다만, 추천드립니다" — use anchored/verb-ending patterns instead.
          // Detection: string literal containing '죄송합니다' without anchor chars (^$) or verb endings.
          // This is a heuristic check; the comment explains the authoring rule.
          selector:
            "Literal[value=/죄송합니다/][value!=/[$.^]/]",
          message:
            "Bare '죄송합니다' in answerMustNotMatch matches polite preambles. Use anchored patterns like '죄송합니다[.！\\\\s]*$' or verb forms like '도와드리기\\\\s*어렵'. See scenario.ts answerMustNotMatch JSDoc.",
        },
        {
          // Bare '모르겠어' matches "모르겠어도 추천드립니다" (concessive + recommendation).
          // Use a verb-ending or sentence-terminal form.
          selector:
            "Literal[value=/모르겠어/][value!=/[$.^어요습]/]",
          message:
            "Bare '모르겠어' in answerMustNotMatch matches concessive clauses. Use terminal forms like '모르겠어요\\\\.' or '모르겠습니다[.！]*$'. See scenario.ts answerMustNotMatch JSDoc.",
        },
      ],
    },
  },
);
