import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCodeowners,
  findCoveringLine,
  findOwningLine,
  buildCodeownersAddition,
  codeownersFor,
  codeownersForFiles,
} from './codeowners.ts'

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
  const covering = (required: string) =>
    findCoveringLine(required, lines)?.owners

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
    assert.deepEqual(findCoveringLine('package-lock.json', anchored)?.owners, [
      '@a',
    ])
    assert.deepEqual(findCoveringLine('yarn.lock', anchored)?.owners, ['@b'])
  })

  it('returns null when nothing covers the pattern', () => {
    assert.equal(findCoveringLine('Dockerfile', parseCodeowners('/x @a')), null)
  })
})

describe('findOwningLine', () => {
  it('returns the covering line when it has owners', () => {
    const lines = parseCodeowners('package-lock.json @npm')
    assert.deepEqual(findOwningLine('package-lock.json', lines)?.owners, [
      '@npm',
    ])
  })

  it('treats an ownerless covering line as no coverage', () => {
    const lines = parseCodeowners('* @everyone\npackage-lock.json')
    assert.equal(findOwningLine('package-lock.json', lines), null)
    assert.deepEqual(findOwningLine('Dockerfile', lines)?.owners, ['@everyone'])
  })
})

describe('codeownersFor', () => {
  const lines = parseCodeowners(`
# Fallback
*                 @global

*.js              @js-owner
**/logs           @octocat
/build/logs/      @doctocat
/docs/            @doctocat
docs/*            docs@example.com
apps/             @octocat
/scripts/         @doctocat @octocat
/apps/            @octocat
/apps/github      # no owner
package-lock.json @marek-saji
/.github/workflows/ @marek-saji
`)
  const owners = (file: string) => codeownersFor(file, lines)

  it('falls back to the wildcard rule', () => {
    assert.deepEqual(owners('README.md'), ['@global'])
    assert.deepEqual(owners('deep/ly/nested/file.txt'), ['@global'])
  })

  it('matches unanchored patterns at any depth', () => {
    assert.deepEqual(owners('foo.js'), ['@js-owner'])
    assert.deepEqual(owners('src/lib/foo.js'), ['@js-owner'])
    assert.deepEqual(owners('package-lock.json'), ['@marek-saji'])
    assert.deepEqual(owners('packages/a/package-lock.json'), ['@marek-saji'])
  })

  it('anchors patterns with a leading slash', () => {
    assert.deepEqual(owners('build/logs/a.log'), ['@doctocat'])
    assert.deepEqual(owners('foo/build/a.log'), ['@global'])
    assert.deepEqual(owners('.github/workflows/ci.yaml'), ['@marek-saji'])
  })

  it('only covers direct children for `dir/*`', () => {
    assert.deepEqual(owners('docs/getting-started.md'), ['docs@example.com'])
    // Nested files fall through to the earlier `/docs/` rule.
    assert.deepEqual(owners('docs/build-app/troubleshooting.md'), ['@doctocat'])
  })

  it('matches directory patterns anywhere when unanchored', () => {
    assert.deepEqual(owners('foo/apps/x.txt'), ['@octocat'])
    assert.deepEqual(owners('a/b/logs/x.log'), ['@octocat'])
  })

  it('treats a bare path as the path and its subtree', () => {
    assert.deepEqual(owners('apps/github'), [])
    assert.deepEqual(owners('apps/github/x.txt'), [])
    assert.deepEqual(owners('apps/other/x.txt'), ['@octocat'])
  })

  it('accepts a leading slash on the file', () => {
    assert.deepEqual(owners('/scripts/run.sh'), ['@doctocat', '@octocat'])
  })

  it('returns null when nothing matches', () => {
    assert.equal(codeownersFor('x', parseCodeowners('/y @a')), null)
  })

  it('skips character-range rules, which GitHub does not support', () => {
    const bracketLines = parseCodeowners(`
*.js         @js-owner
file[12].js  @range-owner
`)
    assert.deepEqual(codeownersFor('file1.js', bracketLines), ['@js-owner'])
    assert.deepEqual(codeownersFor('file[12].js', bracketLines), ['@js-owner'])
  })

  it('unions owners of several files in first-seen order', () => {
    assert.deepEqual(
      codeownersForFiles(['scripts/a.sh', 'foo.js', 'apps/github'], lines),
      ['@doctocat', '@octocat', '@js-owner']
    )
    assert.deepEqual(codeownersForFiles(['apps/github'], lines), [])
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
