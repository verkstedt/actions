import { createVerkstedtConfig } from '@verkstedt/lint/eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  await createVerkstedtConfig({
    dir: import.meta.dirname,
    // If you have TypeScript files that are NOT included in your tsconfig (e.g.
    // config files or scripts), you specify them here.
    // https://typescript-eslint.io/packages/parser/#allowdefaultproject
    allowDefaultProject: ['*.config.*'],
    // Custom config for no-restricted-imports rule
    // https://eslint.org/docs/latest/rules/no-restricted-imports
    noRestrictedImportsConfig: {},
  }),
]);
