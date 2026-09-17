import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { callsTo, fakeLog, fakeRepo, fakeSnapshot } from '../fixtures.ts'
import { codeowners } from './codeowners.ts'
import type { ActionContext } from '../types.ts'

describe('codeowners', () => {
  it('adds lines with the matched owners and suggests them as reviewers', async () => {
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'package-lock.json', 'Dockerfile'],
      files: { '.github/CODEOWNERS': 'package-lock.json @bob @org/devs\n' },
    })
    const findings = await codeowners.run(snapshot)
    assert.equal(findings.length, 1)
    const [finding] = findings
    assert.equal(finding.level, 'info')
    assert.equal(finding.summary, 'CODEOWNERS lacks owners for `Dockerfile`')
    assert.deepEqual(finding.reviewers, ['@bob', '@org/devs'])
    if (finding.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(finding.fix.path, '.github/CODEOWNERS')
    assert.equal(
      finding.fix.content,
      'package-lock.json @bob @org/devs\nDockerfile  @bob @org/devs\n'
    )
    assert.equal(
      finding.fix.describe,
      'added 1 line(s) to `.github/CODEOWNERS`: `Dockerfile`'
    )
  })

  it('creates the file with @OWNER and a comment action when nobody matches', async () => {
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'package-lock.json', '.github/workflows/ci.yaml'],
    })
    const findings = await codeowners.run(snapshot)
    assert.equal(findings.length, 2)
    const [addition, comment] = findings
    assert.equal(addition.reviewers, undefined)
    if (addition.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(addition.fix.path, 'CODEOWNERS')
    assert.equal(
      addition.fix.content,
      [
        '# Make sure dependabot PRs get reviewers assigned',
        'package-lock.json  @OWNER',
        '/.github/workflows/  @OWNER',
        '',
      ].join('\n')
    )
    assert.equal(comment.level, 'warning')
    assert.equal(
      comment.summary,
      'added CODEOWNERS lines use the `@OWNER` placeholder'
    )
    if (comment.fix?.kind !== 'action') throw new Error('expected action')
    assert.equal(comment.fix.afterPr, true)

    const octokit = fakeRepo()
    const ctx: ActionContext = {
      octokit,
      org: 'org',
      repo: 'r',
      pr: {
        number: 42,
        html_url: 'https://p/42',
        head: { ref: 'b', sha: 'prhead' },
      },
      // A later check prepended a line, so the placeholders moved down.
      files: {
        CODEOWNERS: [
          '# Make sure dependabot PRs get reviewers assigned',
          '/docs/  @writer',
          'package-lock.json  @OWNER',
          '/.github/workflows/  @OWNER',
          '',
        ].join('\n'),
      },
      log: fakeLog(),
    }
    assert.equal(await comment.fix.run(ctx), 'commented on the `@OWNER` lines')
    const [review] = callsTo(octokit, 'pulls.createReview')
    assert.equal(review.commit_id, 'prhead')
    assert.equal(review.comments[0].path, 'CODEOWNERS')
    assert.equal(review.comments[0].start_line, 3)
    assert.equal(review.comments[0].line, 4)
    assert.match(review.comments[0].body, /replace the `@OWNER` placeholder/)
  })

  it('reports nothing to do but still suggests reviewers when covered', async () => {
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'package-lock.json'],
      files: { CODEOWNERS: 'package-lock.json @alice\n' },
    })
    assert.deepEqual(await codeowners.run(snapshot), [
      {
        level: 'info',
        summary: 'CODEOWNERS covers every dependabot file',
        reviewers: ['@alice'],
      },
    ])
  })

  it('treats a covering line without owners as missing', async () => {
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'package-lock.json'],
      files: { '.github/CODEOWNERS': '/docs/ @writer\npackage-lock.json\n' },
    })
    const [finding] = await codeowners.run(snapshot)
    if (finding.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(
      finding.fix.content,
      '/docs/ @writer\npackage-lock.json\npackage-lock.json  @OWNER\n'
    )
  })

  it('builds on a CODEOWNERS created earlier in the run', async () => {
    const snapshot = await fakeSnapshot({
      paths: ['package.json', 'yarn.lock'],
    })
    snapshot.workingCopy.attach('CODEOWNERS', '/docs/ @writer\n')
    const [finding] = await codeowners.run(snapshot)
    if (finding.fix?.kind !== 'file') throw new Error('expected file fix')
    assert.equal(finding.fix.path, 'CODEOWNERS')
    assert.equal(
      finding.fix.content,
      [
        '/docs/ @writer',
        '',
        '# Make sure dependabot PRs get reviewers assigned',
        'yarn.lock  @OWNER',
        '',
      ].join('\n')
    )
    assert.equal(
      finding.fix.describe,
      'added 1 line(s) to `CODEOWNERS`: `yarn.lock`'
    )
  })
})
