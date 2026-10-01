import { createVerkstedtConfig } from '@verkstedt/lint/eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  await createVerkstedtConfig({
    dir: import.meta.dirname,
    // If you have TypeScript files that are NOT included in your tsconfig (e.g.
    // config files or scripts), you specify them here.
    // https://typescript-eslint.io/packages/parser/#allowdefaultproject
    allowDefaultProject: ['*/*.mjs'],
    // Custom config for no-restricted-imports rule
    // https://eslint.org/docs/latest/rules/no-restricted-imports
    noRestrictedImportsConfig: {},
  }),
  {
    name: 'all files',
    rules: {
      'no-restricted-syntax': 'off',
      'no-await-in-loop': 'off',
    },
  },
  {
    name: 'repo-hygiene tests',
    files: ['repo-hygiene/**/*.test.ts'],
    rules: {
      // `describe` and `it` from node:test return promises that the
      // runner tracks itself.
      '@typescript-eslint/no-floating-promises': 'off',
      // Stubs implement Promise-returning interfaces.
      '@typescript-eslint/require-await': 'off',
    },
  },
]);
