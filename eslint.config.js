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
        // NOTE: Math.random() is NOT banned via lint — it has legitimate uses
        // for jitter/delay in retry logic. The CLAUDE.md quality bar prohibits
        // Math.random() for ID generation (use crypto.randomUUID() instead).
        // This is enforced via code review, not lint.
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
  /** Tests + src/__tests__: mocks, stubs, and Vitest patterns. */
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
       * Re-enabled for tests: unused variables in test code are often dead
       * leftovers (e.g. seenIndices pushed-to but never read) that mask bugs.
       * Prefix with `_` if intentionally unused.
       */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
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
);
