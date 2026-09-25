import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fakeLog } from '../__fixtures__/log.ts'
import { listCallsTo } from '../__fixtures__/octokit.ts'
import { fakeRepo, fakeSnapshot } from '../__fixtures__/repo.ts'
import { repoSettings } from './repo-settings.ts'
import type { ActionContext, GitHub } from '../types.ts'

const actionContext = (
  octokit: ReturnType<typeof fakeRepo>
): ActionContext => ({
  octokit,
  org: 'org',
  repo: 'r',
  pr: null,
  files: {},
  log: fakeLog(),
})

const wanted: GitHub.Repository = {
  private: false,
  visibility: 'public',
  has_issues: true,
  has_projects: false,
  has_wiki: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
}

async function findingsFor(repository: Partial<GitHub.Repository>) {
  const octokit = fakeRepo({ repository })
  const snapshot = await fakeSnapshot({ octokit })
  return { octokit, findings: await repoSettings.run(snapshot) }
}

describe('repoSettings', () => {
  it('reports nothing to do when every setting is as wanted', async () => {
    const { findings } = await findingsFor(wanted)
    assert.deepEqual(findings, [
      { level: 'info', summary: 'repository settings are as wanted' },
    ])
  })

  it('proposes one action fixing every differing setting', async () => {
    const { octokit, findings } = await findingsFor({})
    assert.equal(findings.length, 1)
    const [finding] = findings
    assert.equal(finding.level, 'info')
    assert.deepEqual(finding.details, [
      'disable the wiki',
      'disable projects',
      'allow auto-merge',
      'delete branches once merged',
    ])
    if (finding.fix?.kind !== 'action') {
      throw new Error('expected action')
    }
    assert.equal(finding.fix.describe, finding.details?.join(', '))

    const result = await finding.fix.run(actionContext(octokit))
    assert.equal(result, finding.details?.join(', '))
    assert.deepEqual(listCallsTo(octokit, 'repos.update'), [
      {
        owner: 'org',
        repo: 'r',
        has_wiki: false,
        has_projects: false,
        allow_auto_merge: true,
        delete_branch_on_merge: true,
      },
    ])
  })

  it('leaves issues alone on a public repo', async () => {
    const { findings } = await findingsFor({ ...wanted, has_issues: true })
    assert.equal(findings[0].fix, undefined)
  })

  it('disables issues on a private repo', async () => {
    const { octokit, findings } = await findingsFor({
      ...wanted,
      private: true,
      visibility: 'private',
    })
    assert.deepEqual(findings[0].details, [
      'disable issues (not a public repo)',
    ])
    if (findings[0].fix?.kind !== 'action') {
      throw new Error('expected action')
    }
    await findings[0].fix.run(actionContext(octokit))
    assert.deepEqual(listCallsTo(octokit, 'repos.update'), [
      { owner: 'org', repo: 'r', has_issues: false },
    ])
  })

  it('treats an internal repo as not public', async () => {
    const { findings } = await findingsFor({
      ...wanted,
      private: true,
      visibility: 'internal',
    })
    assert.deepEqual(findings[0].details, [
      'disable issues (not a public repo)',
    ])
  })

  it('falls back to the private flag without a visibility', async () => {
    const { findings } = await findingsFor({
      ...wanted,
      private: true,
      visibility: undefined,
    })
    assert.deepEqual(findings[0].details, [
      'disable issues (not a public repo)',
    ])
  })
})
