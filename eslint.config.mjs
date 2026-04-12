// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // -------------------------------------------------------------------------
  // Global ignores
  // -------------------------------------------------------------------------
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.angular/**',
      '**/coverage/**',
      '**/out-tsc/**',
    ],
  },

  // -------------------------------------------------------------------------
  // Base JS recommended rules (applies to all JS/TS files)
  // -------------------------------------------------------------------------
  eslint.configs.recommended,

  // -------------------------------------------------------------------------
  // TypeScript rules — API package
  // -------------------------------------------------------------------------
  {
    files: ['packages/api/src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused variables/params prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Warn rather than error on explicit any — service code wraps untyped CLIs
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // -------------------------------------------------------------------------
  // TypeScript rules — Shared package
  // -------------------------------------------------------------------------
  {
    files: ['packages/shared/src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // -------------------------------------------------------------------------
  // TypeScript rules — Angular Web package
  // -------------------------------------------------------------------------
  {
    files: ['packages/web/src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // -------------------------------------------------------------------------
  // Prettier compatibility — MUST be last to override formatting rules
  // -------------------------------------------------------------------------
  eslintConfigPrettier,
);
