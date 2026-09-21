import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createHttpError, listCallsTo } from './__fixtures__/octokit.ts'
import { fakeRepo } from './__fixtures__/repo.ts'
import { runAudit } from './run.ts'
import type { Check, LogEntry } from './types.ts'

const repos = [
  { name: 'a', default_branch: 'main', size: 1 },
  { name: 'b', default_branch: 'main', size: 1 },
]

describe('runAudit', () => {
  it('audits every target repo and skips the App check when told', async () => {
    const seen: Array<string> = []
    const check: Check = {
      name: 'spy',
      run: async (snapshot) => {
        seen.push(snapshot.repo)
        return [{ level: 'info', summary: 'looked' }]
      },
    }
    const octokit = fakeRepo({
      handlers: {
        'repos.listForOrg': () => repos,
        'GET /installation/repositories': () => {
          throw createHttpError(403)
        },
      },
    })
    const entries: Array<LogEntry> = []
    const { findings, previews, repoCount } = await runAudit(octokit, {
      org: 'org',
      dryRun: true,
      reposFilter: [],
      runId: 0,
      runAttempt: 0,
      requireAppAccess: false,
      log: (entry) => entries.push(entry),
      checks: [check],
    })
    assert.deepEqual(seen, ['a', 'b'])
    assert.equal(repoCount, 2)
    assert.deepEqual(previews, [])
    assert.deepEqual(
      findings.map((f) => [f.repo, f.summary]),
      [
        ['org/a', 'looked'],
        ['org/b', 'looked'],
      ]
    )
    assert.equal(
      listCallsTo(octokit, 'GET /installation/repositories').length,
      0
    )
    assert.deepEqual(entries[0], {
      level: 'info',
      message: 'Auditing 2 repo(s) in org (dry run)',
    })
    assert.deepEqual(
      entries.filter((e) => e.check).map((e) => [e.repo, e.check]),
      [
        [{ name: 'a', position: 1, total: 2 }, 'spy'],
        [{ name: 'b', position: 2, total: 2 }, 'spy'],
      ]
    )
  })

  it('turns a repo that cannot be audited into an error finding', async () => {
    const octokit = fakeRepo({
      handlers: {
        'repos.listForOrg': () => repos,
        'git.getRef': ({ repo }: { repo: string }) => {
          if (repo === 'a') {
            throw createHttpError(500, 'boom')
          }
          return { object: { sha: 'head' } }
        },
      },
    })
    const { findings } = await runAudit(octokit, {
      org: 'org',
      dryRun: true,
      reposFilter: [],
      runId: 0,
      runAttempt: 0,
      requireAppAccess: false,
      log: () => {},
      checks: [],
    })
    assert.deepEqual(
      findings.map((f) => [f.repo, f.level, f.details]),
      [['org/a', 'error', ['boom']]]
    )
  })
})
