const sharedRules = {
  'no-restricted-syntax': 'off',
  'no-await-in-loop': 'off',
}

module.exports = {
  root: true,
  extends: ['@verkstedt/verkstedt/vanilla'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  ignorePatterns: ['dist', 'node_modules'],
  rules: sharedRules,
  overrides: [
    {
      files: ['repo-hygiene/**/*.ts'],
      extends: ['@verkstedt/verkstedt/typescript'],
      parserOptions: {
        project: 'repo-hygiene/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      rules: sharedRules,
    },
    {
      files: ['repo-hygiene/**/*.test.ts'],
      rules: {
        // `describe` and `it` from node:test return promises that the
        // runner tracks itself.
        '@typescript-eslint/no-floating-promises': 'off',
      },
    },
    {
      files: [
        'repo-hygiene/lib/checks/**/*.ts',
        'repo-hygiene/lib/__fixtures__/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
}
