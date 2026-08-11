// Flat ESLint config for the EDS MCP server.
//
// Uses the recommended JavaScript + typescript-eslint rule sets. Scoped to
// source and tests; the compiled `dist/` is ignored.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused params/vars prefixed with `_` (e.g. the
      // `_args` placeholder on no-argument tool handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
