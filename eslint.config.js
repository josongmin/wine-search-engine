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
        'warn',
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
);
