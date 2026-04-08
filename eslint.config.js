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
      /** DP / index-heavy code still uses `!`; tighten incrementally. */
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
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
          // in regex.pattern, so this rule uses a negative lookbehind for '[' to
          // avoid false positives on the already-correct bracketed form.
          selector: 'Literal[regex.pattern=/(?<!\\[)\\\\p\\{[LN]\\}\\\\p\\{[LN]\\}(?!\\])/]',
          message: '\\p{L}\\p{N} without brackets means AND (letter then digit), not OR. Use [\\p{L}\\p{N}] character class instead. (Ingestion audit bug #1)',
        },
        // NOTE: Math.random() is NOT banned via lint — it has legitimate uses
        // for jitter/delay in retry logic. The CLAUDE.md quality bar prohibits
        // Math.random() for ID generation (use crypto.randomUUID() instead).
        // This is enforced via code review, not lint.
      ],
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
