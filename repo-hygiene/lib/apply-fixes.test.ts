import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { applyFixes } from './apply-fixes.ts'
import { fakeLog } from './__fixtures__/log.ts'
import { createHttpError, listCallsTo } from './__fixtures__/octokit.ts'
import { fakeRepo, fakeSnapshot } from './__fixtures__/repo.ts'
import type { ActionFix, FileFix, Finding } from './types.ts'

const run = { dryRun: false, runId: 123, runAttempt: 2 }

const file = (
  path: string,
  content: string,
  describeText = `write ${path}`
): FileFix => ({
  kind: 'file',
  path,
  content,
  lang: 'yaml',
  describe: describeText,
})

const finding = (partial: Partial<Finding>): Finding => ({
  repo: 'org/r',
  level: 'info',
  summary: 'something',
  ...partial,
})

describe('applyFixes', () => {
  it('opens one PR with every accepted file fix and marks the findings fixed', async () => {
    const octokit = fakeRepo({ files: { CODEOWNERS: 'old\n' } })
    const snapshot = await fakeSnapshot({ octokit })
    snapshot.workingCopy.attach('.github/dependabot.yaml', 'version: 2\n')
    snapshot.workingCopy.attach('CODEOWNERS', 'old\nnew\n')
    const findings = [
      finding({
        summary: 'dependabot config missing',
        fix: file(
          '.github/dependabot.yaml',
          'version: 2\n',
          'created `.github/dependabot.yaml`'
        ),
      }),
      finding({
        summary: 'CODEOWNERS lacks owners',
        reviewers: ['@bob', '@org/devs'],
        fix: file(
          'CODEOWNERS',
          'old\nnew\n',
          'added 1 line(s) to `CODEOWNERS`'
        ),
      }),
    ]
    const result = await applyFixes(findings, snapshot, run)

    assert.deepEqual(listCallsTo(octokit, 'git.createRef'), [
      {
        owner: 'org',
        repo: 'r',
        ref: 'refs/heads/chore/repo-hygiene/123-2',
        sha: 'head',
      },
    ])
    const commits = listCallsTo(octokit, 'repos.createOrUpdateFileContents')
    assert.deepEqual(
      commits.map((c) => [c.path, c.message, c.sha]),
      [
        [
          '.github/dependabot.yaml',
          'chore: Add .github/dependabot.yaml',
          undefined,
        ],
        ['CODEOWNERS', 'chore: Update CODEOWNERS', 'sha-CODEOWNERS'],
      ]
    )
    const [pr] = listCallsTo(octokit, 'pulls.create')
    assert.equal(pr.title, 'chore: Repo hygiene')
    assert.equal(pr.base, 'main')
    assert.equal(pr.head, 'chore/repo-hygiene/123-2')
    assert.doesNotMatch(pr.body, /Assigned/)
    assert.match(
      pr.body,
      /## What\?\n\n- created `\.github\/dependabot\.yaml`\n- added 1 line\(s\) to `CODEOWNERS`$/
    )
    assert.deepEqual(
      listCallsTo(octokit, 'pulls.requestReviewers').map(
        (p) => p.reviewers ?? p.team_reviewers
      ),
      [['bob'], ['devs']]
    )
    for (const f of result.findings) {
      assert.deepEqual(f.outcome, {
        status: 'fixed',
        url: 'https://p/42',
        detail: 'reviewers: @bob, @org/devs',
      })
    }
    assert.equal(result.preview, null)
  })

  it('falls back to CODEOWNERS owners, then contributors, and says so in the body', async () => {
    const octokit = fakeRepo({
      files: { 'docs/CODEOWNERS': '/docs/ @writer\n' },
    })
    const snapshot = await fakeSnapshot({ octokit })
    snapshot.workingCopy.attach('x', '1')
    await applyFixes([finding({ fix: file('x', '1') })], snapshot, run)
    assert.match(
      listCallsTo(octokit, 'pulls.create')[0].body,
      /Assigned people from CODEOWNERS/
    )
    assert.deepEqual(
      listCallsTo(octokit, 'pulls.requestReviewers')[0].reviewers,
      ['writer']
    )

    const octokit2 = fakeRepo()
    const snapshot2 = await fakeSnapshot({ octokit: octokit2 })
    snapshot2.workingCopy.attach('x', '1')
    await applyFixes([finding({ fix: file('x', '1') })], snapshot2, run)
    assert.match(
      listCallsTo(octokit2, 'pulls.create')[0].body,
      /Assigned repo contributors/
    )
    assert.deepEqual(
      listCallsTo(octokit2, 'pulls.requestReviewers')[0].reviewers,
      ['alice']
    )
  })

  it('renders the PR instead of opening it in a dry run', async () => {
    const octokit = fakeRepo()
    const snapshot = await fakeSnapshot({ octokit })
    snapshot.workingCopy.attach('.github/dependabot.yaml', 'version: 2\n')
    const result = await applyFixes(
      [
        finding({
          reviewers: ['@bob'],
          fix: file('.github/dependabot.yaml', 'version: 2\n', 'created it'),
        }),
        finding({
          summary: 'no reviewers',
          url: 'https://p/1',
          fix: {
            kind: 'action',
            describe: 'request @bob',
            run: async () => {
              throw new Error('must not run')
            },
          },
        }),
      ],
      snapshot,
      { ...run, dryRun: true }
    )
    assert.equal(listCallsTo(octokit, 'git.createRef').length, 0)
    assert.deepEqual(result.findings[0].outcome, {
      status: 'would-fix',
      detail: 'created it',
    })
    assert.deepEqual(result.findings[1].outcome, {
      status: 'would-fix',
      detail: 'request @bob',
    })
    assert.match(
      result.preview ?? '',
      /^### `org\/r`: chore: Repo hygiene\n\nReviewers:\n\n- @bob\n\n<details>\n<summary>Body and files<\/summary>\n\n<blockquote>\n\n/
    )
    assert.match(
      result.preview ?? '',
      /<\/blockquote>\n\n---\n\n\*\*\.github\/dependabot\.yaml\*\* \(create\):\n\n```yaml\nversion: 2\n\n```\n\n<\/details>\n$/
    )
  })

  it('marks every file finding failed when the PR cannot be opened', async () => {
    const snapshot = await fakeSnapshot({
      handlers: {
        'pulls.create': () => {
          throw createHttpError(403, 'forbidden')
        },
      },
    })
    snapshot.workingCopy.attach('x', '1')
    const result = await applyFixes(
      [finding({ fix: file('x', '1') }), finding({ fix: file('y', '2') })],
      snapshot,
      run
    )
    for (const f of result.findings) {
      assert.deepEqual(f.outcome, { status: 'failed', detail: 'forbidden' })
    }
  })

  it('runs actions in isolation and maps their results to outcomes', async () => {
    const snapshot = await fakeSnapshot()
    const action = (runFn: ActionFix['run']): ActionFix => ({
      kind: 'action',
      describe: 'do it',
      run: runFn,
    })
    const result = await applyFixes(
      [
        finding({ fix: action(async () => 'done @a') }),
        finding({ fix: action(async () => undefined) }),
        finding({
          fix: action(async () => ({ fixed: false, detail: 'nobody' })),
        }),
        finding({
          fix: action(async () => {
            throw new Error('boom')
          }),
        }),
        finding({ summary: 'plain warning', level: 'warning' }),
      ],
      snapshot,
      run
    )
    assert.deepEqual(
      result.findings.map((f) => f.outcome),
      [
        { status: 'fixed', detail: 'done @a' },
        { status: 'fixed', detail: 'do it' },
        { status: 'none', detail: 'nobody' },
        { status: 'failed', detail: 'boom' },
        { status: 'none' },
      ]
    )
  })

  it('passes the PR and final files to afterPr actions, and fails them without a PR', async () => {
    const snapshot = await fakeSnapshot()
    snapshot.workingCopy.attach('CODEOWNERS', 'a  @OWNER\n')
    let seen: { pr: unknown; files: unknown } | null = null
    const afterPr: ActionFix = {
      kind: 'action',
      afterPr: true,
      describe: 'comment',
      run: async ({ pr, files }) => {
        seen = { pr, files }
        return 'commented'
      },
    }
    const withPr = await applyFixes(
      [
        finding({ fix: file('CODEOWNERS', 'a  @OWNER\n') }),
        finding({ fix: afterPr }),
      ],
      snapshot,
      run
    )
    assert.deepEqual(withPr.findings[1].outcome, {
      status: 'fixed',
      detail: 'commented',
    })
    const passed = seen as { pr: { number: number }; files: unknown } | null
    assert.equal(passed?.pr.number, 42)
    assert.deepEqual(passed?.files, { CODEOWNERS: 'a  @OWNER\n' })

    const withoutPr = await applyFixes(
      [finding({ fix: afterPr })],
      await fakeSnapshot(),
      run
    )
    assert.deepEqual(withoutPr.findings[0].outcome, {
      status: 'failed',
      detail: 'hygiene PR was not opened',
    })
  })

  it('logs the summary of every finding left with no fix', async () => {
    const log = fakeLog()
    const snapshot = await fakeSnapshot({ log })
    snapshot.workingCopy.attach('x', '1')
    await applyFixes(
      [
        finding({ summary: 'nothing to do here' }),
        finding({ fix: file('x', '1', 'wrote x') }),
      ],
      snapshot,
      run
    )
    assert.deepEqual(log.calls.info, [
      'opened https://p/42',
      'nothing to do here',
    ])
  })

  it('commits a leading-slash fix path without the slash and exposes it the same way', async () => {
    const snapshot = await fakeSnapshot()
    snapshot.workingCopy.attach('/x', '1')
    let seenFiles: unknown = null
    const afterPr: ActionFix = {
      kind: 'action',
      afterPr: true,
      describe: 'comment',
      run: async ({ files }) => {
        seenFiles = files
        return 'commented'
      },
    }
    const result = await applyFixes(
      [finding({ fix: file('/x', '1') }), finding({ fix: afterPr })],
      snapshot,
      run
    )
    assert.deepEqual(
      listCallsTo(
        snapshot.octokit as never,
        'repos.createOrUpdateFileContents'
      )[0].path,
      'x'
    )
    assert.deepEqual(seenFiles, { x: '1' })
    assert.equal(result.findings[0].outcome?.status, 'fixed')
  })

  it('leaves findings the runner already failed alone', async () => {
    const snapshot = await fakeSnapshot()
    const conflicted = finding({
      fix: file('x', '2'),
      outcome: { status: 'failed', detail: 'conflict' },
    })
    const result = await applyFixes([conflicted], snapshot, run)
    assert.deepEqual(result.findings[0].outcome, {
      status: 'failed',
      detail: 'conflict',
    })
    assert.equal(
      listCallsTo(snapshot.octokit as never, 'pulls.create').length,
      0
    )
  })
})
