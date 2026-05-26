module.exports = {
  extends: ['@verkstedt/verkstedt/vanilla'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    'no-restricted-syntax': 'off',
    'no-await-in-loop': 'off',
  },
}
