import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  callsTo,
  fakeLog,
  fakeRepo,
  fakeSnapshot,
  httpError,
} from '../fixtures.ts'
import { dependabotReviewers } from './dependabot-reviewers.ts'
import type { ActionContext } from '../types.ts'

const dependabotPr = (number: number) => ({
  number,
  html_url: `https://p/${number}`,
  user: { login: 'dependabot[bot]' },
  head: { ref: `dependabot/npm/x-${number}`, sha: 's' },
  requested_reviewers: [],
  requested_teams: [],
})

const actionContext = (
  octokit: ReturnType<typeof fakeRepo>,
  log = fakeLog()
): ActionContext => ({
  octokit,
  org: 'org',
  repo: 'r',
  pr: null,
  files: {},
  log,
})

describe('dependabotReviewers', () => {
  it('proposes the CODEOWNERS owners as an action', async () => {
    const octokit = fakeRepo({
      files: { CODEOWNERS: 'package-lock.json @alice @org/devs\n' },
      openPrs: [dependabotPr(1), { number: 2, user: { login: 'bob' } }],
      handlers: {
        'pulls.listFiles': () => [{ filename: 'package-lock.json' }],
      },
    })
    const snapshot = await fakeSnapshot({ octokit })
    const findings = await dependabotReviewers.run(snapshot)
    assert.equal(findings.length, 1)
    const [finding] = findings
    assert.equal(finding.level, 'info')
    assert.equal(finding.summary, 'Dependabot PR has no reviewers')
    assert.equal(finding.url, 'https://p/1')
    assert.equal(finding.fix?.kind, 'action')
    assert.equal(
      finding.fix?.describe,
      'request @alice, @org/devs as reviewers'
    )

    if (finding.fix?.kind !== 'action') throw new Error('expected action')
    const result = await finding.fix.run(actionContext(octokit))
    assert.equal(result, 'requested @alice, @org/devs')
    assert.deepEqual(
      callsTo(octokit, 'pulls.requestReviewers').map((p) => [
        p.pull_number,
        p.reviewers,
        p.team_reviewers,
      ]),
      [
        [1, ['alice'], undefined],
        [1, undefined, ['devs']],
      ]
    )
  })

  it('reads CODEOWNERS from the default branch, not the working copy', async () => {
    const octokit = fakeRepo({
      files: { CODEOWNERS: 'package-lock.json @alice\n' },
      openPrs: [dependabotPr(1)],
      handlers: {
        'pulls.listFiles': () => [{ filename: 'package-lock.json' }],
      },
    })
    const snapshot = await fakeSnapshot({ octokit })
    snapshot.workingCopy.attach('CODEOWNERS', 'package-lock.json @OWNER\n')
    const [finding] = await dependabotReviewers.run(snapshot)
    assert.equal(finding.fix?.describe, 'request @alice as reviewers')
  })

  it('warns when CODEOWNERS names nobody for the files', async () => {
    const snapshot = await fakeSnapshot({
      files: { CODEOWNERS: '/docs/ @writer\n' },
      openPrs: [dependabotPr(1)],
      handlers: {
        'pulls.listFiles': () => [
          { filename: 'Dockerfile', previous_filename: 'Dockerfile.old' },
        ],
      },
    })
    const findings = await dependabotReviewers.run(snapshot)
    assert.deepEqual(findings, [
      {
        level: 'warning',
        summary: 'Dependabot PR has no reviewers and CODEOWNERS names nobody',
        url: 'https://p/1',
        details: ['Dockerfile', 'Dockerfile.old'],
      },
    ])
  })

  it('skips PRs that already have a review', async () => {
    const snapshot = await fakeSnapshot({
      openPrs: [dependabotPr(1)],
      handlers: { 'pulls.listReviews': () => [{ id: 1 }] },
    })
    assert.deepEqual(await dependabotReviewers.run(snapshot), [])
  })

  it('reports an API failure for one PR and continues with the rest', async () => {
    const snapshot = await fakeSnapshot({
      files: { CODEOWNERS: 'package-lock.json @alice\n' },
      openPrs: [dependabotPr(1), dependabotPr(2)],
      handlers: {
        'pulls.listReviews': ({ pull_number: n }: { pull_number: number }) => {
          if (n === 1) throw httpError(500, 'kaboom')
          return []
        },
        'pulls.listFiles': () => [{ filename: 'package-lock.json' }],
      },
    })
    const findings = await dependabotReviewers.run(snapshot)
    assert.deepEqual(findings[0], {
      level: 'error',
      summary: 'could not check reviewers of Dependabot PR',
      url: 'https://p/1',
      details: ['kaboom'],
    })
    assert.equal(findings[1].url, 'https://p/2')
    assert.equal(findings[1].fix?.kind, 'action')
  })

  it('reports fixed: false when every reviewer is rejected', async () => {
    const octokit = fakeRepo({
      files: { CODEOWNERS: 'package-lock.json @alice @bob\n' },
      openPrs: [dependabotPr(1)],
      handlers: {
        'pulls.listFiles': () => [{ filename: 'package-lock.json' }],
        'pulls.requestReviewers': () => {
          throw httpError(422)
        },
      },
    })
    const [finding] = await dependabotReviewers.run(
      await fakeSnapshot({ octokit })
    )
    if (finding.fix?.kind !== 'action') throw new Error('expected action')
    assert.deepEqual(await finding.fix.run(actionContext(octokit)), {
      fixed: false,
      detail: 'none of @alice, @bob could be requested',
    })
  })
})
