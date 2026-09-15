import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCodeowners,
  findCoveringLine,
  findOwningLine,
  buildCodeownersAddition,
} from './codeowners.mjs'

describe('parseCodeowners', () => {
  it('keeps pattern, owners and the original line index', () => {
    const lines = parseCodeowners(
      '# header\n\npackage-lock.json @a @org/team\n/docs/  # nobody\n'
    )
    assert.deepEqual(lines, [
      {
        pattern: 'package-lock.json',
        owners: ['@a', '@org/team'],
        rawIndex: 2,
      },
      { pattern: '/docs/', owners: [], rawIndex: 3 },
    ])
  })

  it('handles empty input', () => {
    assert.deepEqual(parseCodeowners(''), [])
    assert.deepEqual(parseCodeowners(undefined), [])
  })
})

describe('findCoveringLine', () => {
  const lines = parseCodeowners(`
*                    @everyone
package-lock.json    @npm
/.github/workflows/* @ci
docker-compose.*     @ops
`)
  const covering = (required) => findCoveringLine(required, lines)?.owners

  it('prefers the last matching line', () => {
    assert.deepEqual(covering('package-lock.json'), ['@npm'])
    assert.deepEqual(covering('Dockerfile'), ['@everyone'])
  })

  it('treats a directory as covered by a glob inside it', () => {
    assert.deepEqual(covering('/.github/workflows/'), ['@ci'])
  })

  it('matches globs in existing lines', () => {
    assert.deepEqual(covering('docker-compose.yml'), ['@ops'])
    assert.deepEqual(covering('docker-compose.prod.yaml'), ['@ops'])
  })

  it('ignores leading slashes and `**/` when comparing', () => {
    const anchored = parseCodeowners('/package-lock.json @a\n**/yarn.lock @b')
    assert.deepEqual(findCoveringLine('package-lock.json', anchored).owners, [
      '@a',
    ])
    assert.deepEqual(findCoveringLine('yarn.lock', anchored).owners, ['@b'])
  })

  it('returns null when nothing covers the pattern', () => {
    assert.equal(findCoveringLine('Dockerfile', parseCodeowners('/x @a')), null)
  })
})

describe('findOwningLine', () => {
  it('returns the covering line when it has owners', () => {
    const lines = parseCodeowners('package-lock.json @npm')
    assert.deepEqual(findOwningLine('package-lock.json', lines).owners, [
      '@npm',
    ])
  })

  it('treats an ownerless covering line as no coverage', () => {
    const lines = parseCodeowners('* @everyone\npackage-lock.json')
    assert.equal(findOwningLine('package-lock.json', lines), null)
    assert.deepEqual(findOwningLine('Dockerfile', lines).owners, ['@everyone'])
  })
})

describe('buildCodeownersAddition', () => {
  it('creates a file with a header when there is none', () => {
    const change = buildCodeownersAddition({
      existing: null,
      parsedLines: [],
      requiredPatterns: ['package-lock.json', 'Dockerfile'],
      missingPatterns: ['package-lock.json', 'Dockerfile'],
      ownerToken: '@OWNER',
    })
    assert.equal(change.path, 'CODEOWNERS')
    assert.equal(change.sha, undefined)
    assert.equal(
      change.newContent,
      [
        '# Make sure dependabot PRs get reviewers assigned',
        'package-lock.json  @OWNER',
        'Dockerfile  @OWNER',
        '',
      ].join('\n')
    )
    assert.deepEqual(
      change.missingLines.map((l) => l.lineNumber),
      [2, 3]
    )
    assert.equal(
      change.summary,
      'created `CODEOWNERS` with 2 line(s): `package-lock.json`, `Dockerfile`'
    )
  })

  it('appends after a blank line when no existing line is related', () => {
    const content = '/docs/ @writer\n'
    const change = buildCodeownersAddition({
      existing: { path: '.github/CODEOWNERS', sha: 'abc', content },
      parsedLines: parseCodeowners(content),
      requiredPatterns: ['Dockerfile'],
      missingPatterns: ['Dockerfile'],
      ownerToken: '@OWNER',
    })
    assert.equal(change.path, '.github/CODEOWNERS')
    assert.equal(change.sha, 'abc')
    assert.equal(
      change.newContent,
      [
        '/docs/ @writer',
        '',
        '# Make sure dependabot PRs get reviewers assigned',
        'Dockerfile  @OWNER',
        '',
      ].join('\n')
    )
    assert.deepEqual(
      change.missingLines.map((l) => l.lineNumber),
      [4]
    )
    assert.equal(
      change.summary,
      'added 1 line(s) to `.github/CODEOWNERS`: `Dockerfile`'
    )
  })

  it('inserts right after the last related line, without a header', () => {
    const content = '# hdr\npackage-lock.json @a\n\n/docs/ @b\n'
    const change = buildCodeownersAddition({
      existing: { path: 'CODEOWNERS', sha: 'x', content },
      parsedLines: parseCodeowners(content),
      requiredPatterns: [
        'package-lock.json',
        'Dockerfile',
        '/.github/workflows/',
      ],
      missingPatterns: ['Dockerfile', '/.github/workflows/'],
      ownerToken: '@a',
    })
    assert.equal(
      change.newContent,
      [
        '# hdr',
        'package-lock.json @a',
        'Dockerfile  @a',
        '/.github/workflows/  @a',
        '',
        '/docs/ @b',
        '',
      ].join('\n')
    )
    assert.deepEqual(
      change.missingLines.map((l) => l.lineNumber),
      [3, 4]
    )
    assert.deepEqual(change.addedLines, [
      'Dockerfile  @a',
      '/.github/workflows/  @a',
    ])
  })
})
